import type { ImportPlanService } from '@derailed/shared';
import { FriendlyError } from '../build/git.ts';

/**
 * A compose file, read once and turned into the same objects everything else in
 * Derailed is made of. Not compose as an interface: nobody edits YAML afterwards,
 * and nothing here survives except as ordinary services, storage and variables.
 *
 * The reading is deliberately opinionated the same way every parser in this
 * codebase is: only the fields Derailed can honour become part of the plan, and
 * everything it cannot honour is said plainly at import time, per service, rather
 * than failing at deploy time or, worse, quietly meaning something else.
 */

export interface ComposeReading {
  services: ImportPlanService[];
  warnings: string[];
}

/** What `parseCompose` needs from the repository around the file. */
export interface ComposeContext {
  /** The `.env` beside the file, for `${VAR}` interpolation. */
  env: Record<string, string>;
  /** Reads an `env_file:` entry, or null when it is not there. */
  readEnvFile?: (relativePath: string) => Record<string, string> | null;
}

/** The filenames compose itself looks for, in its own preference order. */
export const COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
];

const MAX_BYTES = 1024 * 1024;

/**
 * `${VAR}`, `${VAR:-fallback}`, `${VAR-fallback}`, `$VAR`, and `$$` for a
 * literal dollar. The required forms (`${VAR:?msg}`) become a warning and an
 * empty string rather than a refusal: the person pastes real values into the
 * Variables tab afterwards, which is where secrets belong anyway.
 */
export function interpolate(
  value: string,
  env: Record<string, string>,
  warn: (message: string) => void,
  where: string,
): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced?: string, operator?: string, argument?: string, bare?: string) => {
      if (whole === '$$') return '$';
      const name = braced ?? bare!;
      const set = env[name] !== undefined && (operator?.startsWith(':') ? env[name] !== '' : true);
      if (set) return env[name]!;
      if (operator === ':-' || operator === '-') return argument ?? '';
      warn(`${where} uses \${${name}}, which is not set anywhere. It came through empty.`);
      return '';
    },
  );
}

/**
 * A command written as one string, split the way a shell would read the easy
 * cases. Anything genuinely shell-shaped (pipes, substitutions) is left to the
 * shell on purpose.
 */
export function shellwords(command: string): string[] {
  if (/[|&;<>()`$]/.test(command)) return ['/bin/sh', '-c', command];
  const words: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = matcher.exec(command);
  while (match) {
    words.push(match[1] ?? match[2] ?? match[3]!);
    match = matcher.exec(command);
  }
  return words;
}

/** `512m`, `1g`, `256M`, plain bytes; compose accepts them all. */
export function memoryToMb(value: unknown): number | null {
  if (typeof value === 'number') return Math.max(64, Math.round(value / (1024 * 1024)));
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const bytes =
    unit === 'g'
      ? amount * 1024 ** 3
      : unit === 'm'
        ? amount * 1024 ** 2
        : unit === 'k'
          ? amount * 1024
          : amount;
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 64 ? mb : null;
}

/** Ports that are almost never the web; the same set the adopt screen uses. */
const UNLIKELY_WEB = new Set([22, 3306, 5432, 6379, 27017, 25, 587, 465, 11211, 2375, 2376]);

function pickWebPort(ports: number[]): number | null {
  const web = ports.find((port) => [80, 8080, 3000, 8000, 5000].includes(port));
  if (web) return web;
  return ports.find((port) => !UNLIKELY_WEB.has(port)) ?? null;
}

/** One `ports:` entry in any of compose's shapes, reduced to the container port. */
function containerPort(entry: unknown, warn: (m: string) => void, where: string): number | null {
  if (typeof entry === 'number') return entry;
  if (typeof entry === 'string') {
    // "80", "8080:80", "127.0.0.1:8080:80", each optionally "/udp".
    const [address, protocol] = entry.split('/');
    if (protocol && protocol.toLowerCase() !== 'tcp') {
      warn(`${where} publishes a ${protocol.toUpperCase()} port, which Derailed does not route.`);
      return null;
    }
    const parts = address!.split(':');
    const target = Number(parts[parts.length - 1]?.split('-')[0]);
    return Number.isInteger(target) && target > 0 ? target : null;
  }
  if (entry && typeof entry === 'object') {
    const long = entry as { target?: number | string; protocol?: string };
    if (long.protocol && long.protocol !== 'tcp') return null;
    const target = Number(long.target);
    return Number.isInteger(target) && target > 0 ? target : null;
  }
  return null;
}

/**
 * The directives that cannot be honoured on a managed server, each with the
 * sentence that says so. Saying it at import time is the whole feature: the
 * alternative is a deploy that fails later, or a container quietly running
 * without the isolation the file asked to break.
 */
const UNSUPPORTED: Record<string, string> = {
  privileged: 'asks for privileged mode, which Derailed never grants',
  cap_add: 'asks for extra kernel capabilities, which Derailed never grants',
  devices: 'asks for host devices, which stay with the host',
  network_mode: 'asks for its own network mode; everything shares the project network instead',
  pid: 'asks to share a process namespace, which stays private',
  ipc: 'asks to share memory with the host, which stays private',
  security_opt: 'asks for security options Derailed does not pass through',
  sysctls: 'asks for kernel settings, which stay as they are',
  userns_mode: 'asks for a user namespace mode Derailed does not pass through',
  extra_hosts: 'adds entries to /etc/hosts, which are not carried over',
  dns: 'asks for its own DNS servers; the project network provides DNS instead',
  entrypoint: 'overrides the image entrypoint, which Derailed does not; only the command is used',
};

interface RawService {
  [key: string]: unknown;
}

export function parseCompose(text: string, context: ComposeContext): ComposeReading {
  if (text.length > MAX_BYTES) {
    throw new FriendlyError('That compose file is unreasonably large.');
  }

  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (err) {
    throw new FriendlyError(
      'That compose file is not valid YAML.',
      err instanceof Error ? err.message.split('\n')[0] : undefined,
    );
  }
  if (!doc || typeof doc !== 'object') {
    throw new FriendlyError('That compose file is empty.');
  }

  const root = doc as { services?: Record<string, RawService>; volumes?: Record<string, unknown> };
  if (!root.services || typeof root.services !== 'object' || !Object.keys(root.services).length) {
    throw new FriendlyError('That compose file has no services in it.');
  }

  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  if ((doc as { networks?: unknown }).networks) {
    warn('The file defines networks. Everything imported shares one project network instead.');
  }
  if ((doc as { secrets?: unknown }).secrets || (doc as { configs?: unknown }).configs) {
    warn(
      "The file uses secrets or configs. Put those values into each app's Variables tab instead.",
    );
  }
  for (const [volumeName, spec] of Object.entries(root.volumes ?? {})) {
    if (spec && typeof spec === 'object' && (spec as { external?: unknown }).external) {
      warn(
        `The volume "${volumeName}" is marked external. Fresh storage is created instead; its current contents do not come along.`,
      );
    }
  }

  const names = Object.keys(root.services);
  const services: ImportPlanService[] = [];

  for (const name of names) {
    const raw: RawService | undefined = root.services[name];
    if (!raw || typeof raw !== 'object') continue;
    const where = `"${name}"`;

    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) {
      warn(`${where} has a name Derailed cannot keep, so it was skipped.`);
      continue;
    }

    if (Array.isArray(raw.profiles) && raw.profiles.length > 0) {
      warn(`${where} only runs under a profile, so it was left out, the same as compose would.`);
      continue;
    }

    for (const [directive, sentence] of Object.entries(UNSUPPORTED)) {
      if (raw[directive] !== undefined) warn(`${where} ${sentence}.`);
    }

    const restart = typeof raw.restart === 'string' ? raw.restart : null;
    if (restart === 'no' || restart === 'on-failure') {
      warn(`${where} asks not to restart automatically; Derailed keeps apps running anyway.`);
    }

    // What runs: a build, an image, or nothing worth importing.
    let source: 'image' | 'repo';
    let image: string | null = null;
    let rootDir: string | null = null;
    let dockerfilePath: string | null = null;

    const build = raw.build;
    if (build !== undefined) {
      source = 'repo';
      const spec =
        typeof build === 'string'
          ? { context: build }
          : ((build ?? {}) as { context?: string; dockerfile?: string; args?: unknown });
      const rawContext = spec.context ?? '.';
      const cleaned = rawContext === '.' ? '' : rawContext.replace(/^\.\//, '');
      if (cleaned.split(/[\\/]/).includes('..') || cleaned.startsWith('/')) {
        warn(`${where} builds from outside the repository, so it was skipped.`);
        continue;
      }
      rootDir = cleaned || null;
      dockerfilePath = spec.dockerfile ?? null;
      if (spec.args) {
        warn(`${where} passes build arguments, which are not carried over.`);
      }
      if (raw.image) {
        // Compose builds and then *names* the image; here the build is the point.
        warn(`${where} both builds and names an image; the build wins.`);
      }
    } else if (typeof raw.image === 'string' && raw.image.trim()) {
      source = 'image';
      image = interpolate(raw.image.trim(), context.env, warn, where);
    } else {
      warn(`${where} has neither an image nor a build, so there is nothing to run. Skipped.`);
      continue;
    }

    // Environment: the map form, the array form, and env_file, merged the way
    // compose merges them (environment wins over env_file).
    const env: Record<string, string> = {};
    const envFiles = Array.isArray(raw.env_file)
      ? raw.env_file
      : typeof raw.env_file === 'string'
        ? [raw.env_file]
        : [];
    for (const file of envFiles) {
      if (typeof file !== 'string') continue;
      const loaded = context.readEnvFile?.(file) ?? null;
      if (!loaded) {
        warn(
          `${where} lists ${file}, which is not in the repository. Its values came through empty.`,
        );
        continue;
      }
      Object.assign(env, loaded);
    }
    const rawEnv: unknown = raw.environment;
    if (Array.isArray(rawEnv)) {
      for (const entry of rawEnv as unknown[]) {
        if (typeof entry !== 'string') continue;
        const eq = entry.indexOf('=');
        const key = eq < 0 ? entry : entry.slice(0, eq);
        const value = eq < 0 ? '' : entry.slice(eq + 1);
        if (eq < 0) {
          warn(
            `${where} passes ${key} through from the machine it runs on. It came through empty.`,
          );
        }
        env[key] = interpolate(value, context.env, warn, where);
      }
    } else if (rawEnv && typeof rawEnv === 'object') {
      for (const [key, value] of Object.entries(rawEnv)) {
        if (value === null || value === undefined) {
          warn(
            `${where} passes ${key} through from the machine it runs on. It came through empty.`,
          );
          env[key] = '';
        } else {
          env[key] = interpolate(String(value), context.env, warn, where);
        }
      }
    }

    // Ports: the container port is all that matters; publishing is Caddy's job.
    const portEntries: unknown[] = Array.isArray(raw.ports) ? raw.ports : [];
    const exposeEntries: unknown[] = Array.isArray(raw.expose) ? raw.expose : [];
    const ports = [...portEntries, ...exposeEntries]
      .map((entry) => containerPort(entry, warn, where))
      .filter((port): port is number => port !== null);
    const port = pickWebPort([...new Set(ports)]);
    if (ports.length > 1) {
      warn(
        `${where} lists more than one port. Web traffic goes to ${port}; neighbours can still reach the rest by name.`,
      );
    }

    // Volumes: whatever shape, the container path is what becomes storage.
    const volumePaths: string[] = [];
    for (const entry of Array.isArray(raw.volumes) ? raw.volumes : []) {
      if (typeof entry === 'string') {
        const stripped = entry.split(':');
        if (stripped.length === 1) {
          // Anonymous volume: "/var/lib/data".
          if (stripped[0]!.startsWith('/')) volumePaths.push(stripped[0]!);
          continue;
        }
        const mountedFrom = stripped[0]!;
        const target = stripped[1]!;
        if (!target.startsWith('/')) continue;
        if (
          mountedFrom.startsWith('.') ||
          mountedFrom.startsWith('/') ||
          mountedFrom.startsWith('~')
        ) {
          warn(
            `${where} mounts the folder ${mountedFrom} from the machine. It becomes fresh managed storage at ${target}; the folder's current contents do not come along.`,
          );
        }
        volumePaths.push(target);
      } else if (entry && typeof entry === 'object') {
        const long = entry as { type?: string; target?: string; source?: string };
        if (!long.target?.startsWith('/')) continue;
        if (long.type === 'tmpfs') {
          warn(`${where} asks for a tmpfs at ${long.target}, which is not carried over.`);
          continue;
        }
        if (long.type === 'bind') {
          warn(
            `${where} mounts the folder ${long.source ?? '?'} from the machine. It becomes fresh managed storage at ${long.target}; the folder's current contents do not come along.`,
          );
        }
        volumePaths.push(long.target);
      }
    }

    // depends_on: the array form and the map form. Conditions cannot be promised.
    let dependsOn: string[] = [];
    if (Array.isArray(raw.depends_on)) {
      dependsOn = raw.depends_on.filter((entry): entry is string => typeof entry === 'string');
    } else if (raw.depends_on && typeof raw.depends_on === 'object') {
      dependsOn = Object.keys(raw.depends_on);
      const wantsHealthy = Object.values(raw.depends_on as Record<string, unknown>).some(
        (condition) =>
          (condition as { condition?: string } | null)?.condition === 'service_healthy',
      );
      if (wantsHealthy) {
        warn(
          `${where} waits for another service to be healthy before starting. Derailed starts things in order but does not hold one for another; apps that retry their connections, which is nearly all of them, are fine.`,
        );
      }
    }
    if (Array.isArray(raw.links) && raw.links.length) {
      // The legacy spelling of the same idea.
      for (const link of raw.links) {
        if (typeof link === 'string') dependsOn.push(link.split(':')[0]!);
      }
    }

    // Command: compose's string form is read like a shell would.
    let command: string[] | null = null;
    if (typeof raw.command === 'string') {
      command = shellwords(interpolate(raw.command, context.env, warn, where));
    } else if (Array.isArray(raw.command)) {
      command = (raw.command as unknown[]).map((part) => String(part));
    }

    const memoryLimitMb =
      memoryToMb(raw.mem_limit) ??
      memoryToMb(
        (raw.deploy as { resources?: { limits?: { memory?: unknown } } } | undefined)?.resources
          ?.limits?.memory,
      );

    services.push({
      name,
      source,
      image,
      rootDir,
      dockerfilePath,
      command,
      port,
      // No web port means no HTTP to demand: the Redis, the worker, the app only
      // its nginx neighbour reaches. The container staying up is their answer.
      healthCheck: port === null ? 'started' : 'http',
      healthPath: null,
      env: Object.entries(env).map(([key, value]) => ({ key, value })),
      volumes: [...new Set(volumePaths)],
      dependsOn: [...new Set(dependsOn)],
      memoryLimitMb,
    });
  }

  if (!services.length) {
    throw new FriendlyError(
      'Nothing in that compose file can be imported.',
      warnings[warnings.length - 1],
    );
  }

  // Dependencies on things that are not there are dropped, with a note.
  const known = new Set(services.map((service) => service.name));
  for (const service of services) {
    for (const dependency of service.dependsOn) {
      if (!known.has(dependency)) {
        warn(
          `"${service.name}" depends on "${dependency}", which is not being imported, so that ordering was dropped.`,
        );
      }
    }
    service.dependsOn = service.dependsOn.filter((dependency) => known.has(dependency));
  }

  return { services, warnings };
}

/**
 * Creation and deploy order: dependencies first. A cycle is reported with its
 * members named rather than half-imported.
 */
export function startOrder(services: ImportPlanService[]): ImportPlanService[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ImportPlanService[] = [];

  const visit = (name: string, trail: string[]) => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new FriendlyError(
        `These services depend on each other in a circle: ${[...trail, name].join(', ')}.`,
        'Break the circle in the compose file and import again.',
      );
    }
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    done.add(name);
    ordered.push(byName.get(name)!);
  };

  for (const service of services) visit(service.name, []);
  return ordered;
}
