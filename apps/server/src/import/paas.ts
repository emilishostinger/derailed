import type { ImportPlanDatabase, ImportPlanJob, ImportPlanService } from '@derailed/shared';
import { FriendlyError } from '../build/git.ts';
import { findEngine } from '../catalog/databases.ts';
import { isValidCron } from '../jobs/schedule.ts';
import { parseToml, type TomlTable } from '../util/toml.ts';
import { shellwords } from './compose.ts';

/**
 * Readers for the files the paid platforms leave in a repository: Heroku's
 * app.json and Procfile, Render's render.yaml, Railway's railway.json, Fly's
 * fly.toml. Each produces the same plan the compose importer does, so the rest
 * of the machinery neither knows nor cares where an app is arriving from.
 *
 * The rule is the same as everywhere else: what can be honoured becomes the
 * plan; what cannot becomes a sentence; secrets never travel, only their names,
 * because the platform never wrote the values into the repository either.
 */

export interface PlatformReading {
  services: ImportPlanService[];
  databases: ImportPlanDatabase[];
  jobs: ImportPlanJob[];
  warnings: string[];
}

function blankService(name: string): ImportPlanService {
  return {
    name,
    source: 'repo',
    image: null,
    rootDir: null,
    dockerfilePath: null,
    command: null,
    port: null,
    healthCheck: 'started',
    healthPath: null,
    env: [],
    volumes: [],
    dependsOn: [],
    memoryLimitMb: null,
  };
}

function newestVersionOf(engine: string): string {
  return findEngine(engine)?.versions[0] ?? '';
}

/** A platform's service name, made safe for a plan without losing the original. */
function safeName(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_.-]/g, '-');
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned.slice(0, 63) : fallback;
}

// ---------------------------------------------------------------------------
// Heroku: app.json + Procfile
// ---------------------------------------------------------------------------

/** `heroku-postgresql:essential-0` and friends, to an engine Derailed runs. */
export function herokuAddonEngine(plan: string): string | null {
  const name = plan.split(':')[0]!.toLowerCase();
  if (name.includes('postgres')) return 'postgres';
  if (name.includes('redis') || name === 'rediscloud' || name === 'openredis') return 'redis';
  if (name === 'cleardb' || name === 'jawsdb') return 'mysql';
  if (name === 'jawsdb-maria') return 'mariadb';
  if (name.includes('mongo') || name === 'ormongo') return 'mongodb';
  return null;
}

export function parseHeroku(appJson: string | null, procfile: string | null): PlatformReading {
  if (!appJson && !procfile) {
    throw new FriendlyError('There is no app.json or Procfile in that repository.');
  }
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  // The processes: one service each, the web one held to answering HTTP.
  const services: ImportPlanService[] = [];
  const lines = (procfile ?? 'web: (from the repository)').split('\n');
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, processName, command] = match;
    if (processName === 'release') {
      warn(
        'The Procfile has a release phase. Derailed does not run one; run that command from the Terminal tab after deploys that need it.',
      );
      continue;
    }
    const service = blankService(safeName(processName!, 'app'));
    if (procfile) service.command = shellwords(command!);
    if (processName === 'web') {
      // Heroku hands the process a PORT and expects it answered; so does Derailed.
      service.healthCheck = 'http';
    }
    services.push(service);
  }
  if (!services.length) {
    const service = blankService('web');
    service.healthCheck = 'http';
    services.push(service);
  }

  const databases: ImportPlanDatabase[] = [];
  let parsed: {
    name?: unknown;
    env?: Record<string, unknown>;
    addons?: unknown[];
    formation?: Record<string, { quantity?: number }>;
  } = {};
  if (appJson) {
    try {
      parsed = JSON.parse(appJson) as typeof parsed;
    } catch {
      throw new FriendlyError('The app.json in that repository is not valid JSON.');
    }

    // Env: names travel, values do not, because the platform never had them in
    // the repository either. Generated secrets are generated here too.
    let unset = 0;
    for (const [key, spec] of Object.entries(parsed.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const detail =
        typeof spec === 'object' && spec !== null
          ? (spec as { value?: unknown; generator?: unknown })
          : { value: spec };
      const generate = detail.generator === 'secret';
      const value = typeof detail.value === 'string' ? detail.value : '';
      if (!value && !generate) unset++;
      for (const service of services) {
        service.env.push({ key, value, ...(generate ? { generate: true } : {}) });
      }
    }
    if (unset > 0) {
      warn(
        `${unset} variable${unset === 1 ? '' : 's'} arrived as names without values. Paste the real values on each app's Variables tab; \`heroku config\` prints them.`,
      );
    }

    for (const addon of parsed.addons ?? []) {
      const plan =
        typeof addon === 'string' ? addon : ((addon as { plan?: string } | null)?.plan ?? '');
      if (!plan) continue;
      const engine = herokuAddonEngine(plan);
      if (!engine) {
        warn(`The add-on "${plan}" has no equivalent here, so it was left out.`);
        continue;
      }
      if (databases.some((database) => database.engine === engine)) continue;
      databases.push({
        name: engine === 'postgres' ? 'db' : engine,
        engine,
        version: newestVersionOf(engine),
        linkTo: services.map((service) => ({ service: service.name })),
      });
    }

    for (const [processName, formation] of Object.entries(parsed.formation ?? {})) {
      if ((formation?.quantity ?? 1) > 1) {
        warn(
          `The formation runs more than one "${processName}". Derailed runs one instance per app; that is the product.`,
        );
      }
    }
  }

  if (databases.some((database) => database.engine === 'postgres')) {
    warn(
      'Your Postgres data comes over with one dump: `heroku pg:backups:capture && heroku pg:backups:download`, then load it through the new database, `pg_restore` on its Connection tab shows the exact command.',
    );
  }

  return { services, databases, jobs: [], warnings };
}

// ---------------------------------------------------------------------------
// Render: render.yaml
// ---------------------------------------------------------------------------

export function parseRender(text: string): PlatformReading {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (err) {
    throw new FriendlyError(
      'That render.yaml is not valid YAML.',
      err instanceof Error ? err.message.split('\n')[0] : undefined,
    );
  }
  const root = (doc ?? {}) as {
    services?: Record<string, unknown>[];
    databases?: Record<string, unknown>[];
  };
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const services: ImportPlanService[] = [];
  const databases: ImportPlanDatabase[] = [];
  const jobs: ImportPlanJob[] = [];
  const crons: { name: string; command: string; schedule: string }[] = [];

  for (const entry of root.databases ?? []) {
    const name = safeName(String(entry.name ?? 'db'), 'db');
    databases.push({
      name,
      engine: 'postgres',
      version: entry.postgresMajorVersion
        ? String(entry.postgresMajorVersion)
        : newestVersionOf('postgres'),
      linkTo: [],
    });
  }

  for (const entry of root.services ?? []) {
    const type = String(entry.type ?? 'web');
    const name = safeName(String(entry.name ?? 'app'), 'app');

    if (type === 'redis' || type === 'keyvalue') {
      databases.push({
        name,
        engine: 'redis',
        version: newestVersionOf('redis'),
        linkTo: [],
      });
      continue;
    }
    if (type === 'cron') {
      const schedule = String(entry.schedule ?? '');
      const command = String(entry.startCommand ?? '');
      if (command && isValidCron(schedule)) {
        crons.push({ name, command, schedule });
      } else {
        warn(`The cron "${name}" has a schedule Derailed cannot read, so it was left out.`);
      }
      continue;
    }
    if (type === 'static') {
      warn(
        `"${name}" is a static site. Deploy its folder as its own app; drag it in, or point Derailed at the repository.`,
      );
      continue;
    }

    const service = blankService(name);
    service.healthCheck = type === 'web' ? 'http' : 'started';
    if (typeof entry.rootDir === 'string' && entry.rootDir) service.rootDir = entry.rootDir;
    const runtime = String(entry.runtime ?? entry.env ?? '');
    if (runtime === 'docker') {
      if (typeof entry.dockerfilePath === 'string') service.dockerfilePath = entry.dockerfilePath;
    } else if (typeof entry.startCommand === 'string' && entry.startCommand) {
      service.command = shellwords(entry.startCommand);
    }
    if (typeof entry.buildCommand === 'string' && entry.buildCommand) {
      warn(
        `"${name}" names a build command. Derailed works the build out itself; if it gets it wrong, add a Dockerfile.`,
      );
    }
    if (typeof entry.healthCheckPath === 'string' && entry.healthCheckPath.startsWith('/')) {
      service.healthPath = entry.healthCheckPath;
    }

    const disk = entry.disk as { mountPath?: string } | undefined;
    if (disk?.mountPath?.startsWith('/')) service.volumes.push(disk.mountPath);

    let unset = 0;
    for (const raw of Array.isArray(entry.envVars) ? entry.envVars : []) {
      const spec = raw as {
        key?: string;
        value?: unknown;
        generateValue?: boolean;
        sync?: boolean;
        fromDatabase?: { name?: string; property?: string };
        fromService?: unknown;
      };
      if (!spec.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.key)) continue;
      if (spec.fromDatabase?.name) {
        const database = databases.find(
          (candidate) => candidate.name === safeName(String(spec.fromDatabase!.name), 'db'),
        );
        if (database) {
          database.linkTo.push({ service: name, injectAs: spec.key });
          continue;
        }
      }
      if (spec.fromService) {
        warn(
          `"${name}" reads ${spec.key} from another service. Its neighbours answer by name here; set that value by hand on the Variables tab.`,
        );
        continue;
      }
      if (spec.generateValue) {
        service.env.push({ key: spec.key, value: '', generate: true });
        continue;
      }
      const value = spec.value === undefined || spec.value === null ? '' : String(spec.value);
      if (!value) unset++;
      service.env.push({ key: spec.key, value });
    }
    if (unset > 0) {
      warn(
        `"${name}" has ${unset} variable${unset === 1 ? '' : 's'} whose values live in Render's dashboard, not the file. Paste them on the Variables tab.`,
      );
    }

    services.push(service);
  }

  if (!services.length && !databases.length) {
    throw new FriendlyError('That render.yaml has nothing Derailed can import.');
  }

  // A Render cron is its own little machine; here it becomes a scheduled command
  // in the container of the service that shares its code.
  const host = services.find((service) => service.healthCheck === 'http') ?? services[0];
  for (const cron of crons) {
    if (!host) {
      warn(`The cron "${cron.name}" has no app to run inside, so it was left out.`);
      continue;
    }
    jobs.push({
      name: cron.name,
      command: cron.command,
      schedule: cron.schedule,
      service: host.name,
    });
  }

  // A database nothing linked to still gets connected to the web service: an
  // address nobody can find is not a database.
  for (const database of databases) {
    if (!database.linkTo.length && host) database.linkTo.push({ service: host.name });
  }

  return { services, databases, jobs, warnings };
}

// ---------------------------------------------------------------------------
// Railway: railway.json
// ---------------------------------------------------------------------------

export function parseRailway(text: string): PlatformReading {
  let parsed: {
    build?: { dockerfilePath?: string };
    deploy?: {
      startCommand?: string;
      healthcheckPath?: string;
      numReplicas?: number;
      cronSchedule?: string;
    };
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new FriendlyError('That railway.json is not valid JSON.');
  }

  const warnings: string[] = [
    "Railway keeps databases and variables in its dashboard, not in this file. Add a database from the catalogue, and paste variables on the app's Variables tab; `railway variables` prints them.",
  ];
  const service = blankService('app');
  service.healthCheck = 'http';
  if (parsed.build?.dockerfilePath) service.dockerfilePath = parsed.build.dockerfilePath;
  if (parsed.deploy?.startCommand) service.command = shellwords(parsed.deploy.startCommand);
  if (parsed.deploy?.healthcheckPath?.startsWith('/')) {
    service.healthPath = parsed.deploy.healthcheckPath;
  }
  if ((parsed.deploy?.numReplicas ?? 1) > 1) {
    warnings.push('The file asks for replicas. Derailed runs one instance per app.');
  }
  if (parsed.deploy?.cronSchedule) {
    service.healthCheck = 'started';
    warnings.push(
      'This service runs on a schedule on Railway. Here it runs continuously; move the schedule to a Derailed job if it should not.',
    );
  }

  return { services: [service], databases: [], jobs: [], warnings };
}

// ---------------------------------------------------------------------------
// Fly: fly.toml
// ---------------------------------------------------------------------------

export function parseFly(text: string): PlatformReading {
  const doc = parseToml(text);
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const appName = typeof doc.app === 'string' ? safeName(doc.app, 'app') : 'app';
  const build = (doc.build ?? {}) as TomlTable;
  const env = (doc.env ?? {}) as TomlTable;

  const image = typeof build.image === 'string' ? build.image : null;
  const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : null;

  // The port the app answers on: [http_service] on modern files, [[services]]
  // on older ones.
  let port: number | null = null;
  const httpService = doc.http_service as TomlTable | undefined;
  if (httpService && typeof httpService.internal_port === 'number') {
    port = httpService.internal_port;
  } else if (Array.isArray(doc.services)) {
    for (const entry of doc.services) {
      const table = entry as TomlTable;
      if (typeof table.internal_port === 'number') {
        port = table.internal_port;
        break;
      }
    }
  }

  // Process groups: each is a service running the same code with its own command.
  const processes = (doc.processes ?? {}) as TomlTable;
  const processNames = Object.keys(processes);
  const webProcesses = new Set<string>(
    Array.isArray(httpService?.processes)
      ? (httpService!.processes as unknown[]).map(String)
      : processNames.length
        ? [processNames[0]!]
        : ['app'],
  );

  const services: ImportPlanService[] = [];
  const serviceOfProcess = new Map<string, ImportPlanService>();
  const make = (name: string, command: string | null): ImportPlanService => {
    const service = blankService(name === 'app' && appName ? appName : name);
    service.source = image ? 'image' : 'repo';
    service.image = image;
    service.dockerfilePath = image ? null : dockerfile;
    if (command) service.command = shellwords(command);
    for (const [key, value] of Object.entries(env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        service.env.push({ key, value: String(value) });
      }
    }
    return service;
  };

  if (processNames.length) {
    for (const processName of processNames) {
      const service = make(
        safeName(processName === 'app' ? appName : `${appName}-${processName}`, 'app'),
        typeof processes[processName] === 'string' ? (processes[processName] as string) : null,
      );
      if (webProcesses.has(processName)) {
        service.healthCheck = 'http';
        service.port = port;
      }
      serviceOfProcess.set(processName, service);
      services.push(service);
    }
  } else {
    const service = make(appName, null);
    service.healthCheck = 'http';
    service.port = port;
    serviceOfProcess.set('app', service);
    services.push(service);
  }

  // Mounts: fly volumes by destination path.
  const mounts = Array.isArray(doc.mounts)
    ? (doc.mounts as TomlTable[])
    : doc.mounts && typeof doc.mounts === 'object'
      ? [doc.mounts as TomlTable]
      : [];
  for (const mount of mounts) {
    const destination = typeof mount.destination === 'string' ? mount.destination : null;
    if (!destination?.startsWith('/')) continue;
    const owners =
      Array.isArray(mount.processes) && mount.processes.length
        ? (mount.processes as unknown[]).map(String)
        : null;
    const holders = owners
      ? owners
          .map((owner) => serviceOfProcess.get(owner))
          .filter((service): service is ImportPlanService => !!service)
      : services;
    for (const service of holders) {
      if (!service.volumes.includes(destination)) service.volumes.push(destination);
    }
  }

  const deploy = (doc.deploy ?? {}) as TomlTable;
  if (typeof deploy.release_command === 'string') {
    warn(
      'The file has a release command. Derailed does not run one; run it from the Terminal tab after deploys that need it.',
    );
  }
  warn(
    'Fly keeps Postgres and Redis as separate apps, not in this file. Add a database from the catalogue and move the data with one dump; the Connection tab shows the exact commands.',
  );

  return { services, databases: [], jobs: [], warnings };
}
