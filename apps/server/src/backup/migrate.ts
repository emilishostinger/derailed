import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { allDomains, createDomain } from '../db/repo/domains.ts';
import { listEnv, replaceUserEnv } from '../db/repo/env.ts';
import { listLinks } from '../db/repo/links.ts';
import { createProject, findProjectBySlug, listProjects } from '../db/repo/projects.ts';
import {
  createAppService,
  createDatabaseService,
  findServiceBySlug,
  listServices,
} from '../db/repo/services.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { createVolume, listVolumesFor } from '../db/repo/volumes.ts';
import { createBackup } from './backup.ts';

/**
 * Moving everything to another server.
 *
 * People hesitate to commit to a tool that makes their setup unportable, and the
 * hesitation is reasonable: a year of small decisions living only in one machine's
 * SQLite file is a year you cannot get back if the machine goes.
 *
 * So this is the answer to "what if this project dies", and it is worth being able to
 * say out loud. Everything Derailed knows leaves as one ordinary `.tar.gz` that can
 * be opened with `tar` and read with an editor.
 *
 * Secrets are the one thing that does not travel. Environment variables are encrypted
 * with a key that lives on the old machine, and putting the decrypted values into a
 * file somebody will email themselves would undo the reason they were encrypted. They
 * are exported by name, and asked for again on the other side.
 */

export interface MigrationPlan {
  version: 1;
  exportedAt: number;
  derailedVersion: string;
  projects: {
    slug: string;
    name: string;
    backupSchedule: string;
    services: {
      slug: string;
      name: string;
      kind: string;
      source: string;
      image: string | null;
      repoUrl: string | null;
      branch: string | null;
      rootDir: string | null;
      buildStrategy: string;
      dockerfilePath: string | null;
      port: number | null;
      healthPath: string;
      memoryLimitMb: number | null;
      dbEngine: string | null;
      dbVersion: string | null;
      dbName: string | null;
      dbUser: string | null;
      volumes: string[];
      /** Names only. The values stayed behind, encrypted, on purpose. */
      variableNames: string[];
      domains: { hostname: string; pathPrefix: string | null; kind: string }[];
    }[];
    links: { from: string; to: string; injectAs: string | null }[];
  }[];
  settings: { appBaseDomain: string | null; panelDomain: string | null };
  /** What the person has to do by hand once it is over there. */
  afterwards: string[];
}

/** Everything Derailed knows, minus the things that must not travel. */
export function describeInstall(): MigrationPlan {
  const projects = listProjects().map((project) => {
    const services = listServices(project.id);
    const bySlug = new Map(services.map((service) => [service.id, service.slug]));

    return {
      slug: project.slug,
      name: project.name,
      backupSchedule: project.backupSchedule,
      services: services.map((service) => ({
        slug: service.slug,
        name: service.name,
        kind: service.kind,
        source: service.source,
        image: service.image,
        repoUrl: service.repoUrl,
        branch: service.branch,
        rootDir: service.rootDir,
        buildStrategy: service.buildStrategy,
        dockerfilePath: service.dockerfilePath,
        port: service.port,
        healthPath: service.healthPath,
        memoryLimitMb: service.memoryLimitMb,
        dbEngine: service.dbEngine,
        dbVersion: service.dbVersion,
        dbName: service.dbName,
        dbUser: service.dbUser,
        volumes: listVolumesFor(service.id).map((volume) => volume.containerPath),
        variableNames: listEnv(service.id)
          .filter((entry) => entry.source === 'user')
          .map((entry) => entry.key),
        domains: allDomains()
          .filter((domain) => domain.serviceId === service.id)
          .map((domain) => ({
            hostname: domain.hostname,
            pathPrefix: domain.pathPrefix ?? null,
            kind: domain.kind,
          })),
      })),
      links: listLinks(project.id)
        .map((link) => ({
          from: bySlug.get(link.fromServiceId) ?? '',
          to: bySlug.get(link.toServiceId) ?? '',
          injectAs: link.injectAs,
        }))
        .filter((link) => link.from && link.to),
    };
  });

  const afterwards: string[] = [
    'Point your domains at the new server. Each one needs its A record changing.',
    'Fill in the variables again. Their names came across; their values did not, because they are encrypted with a key that stays on the old machine.',
  ];
  if (projects.some((project) => project.services.some((service) => service.repoUrl))) {
    afterwards.push("Add tokens for any private repositories, on each app's Settings tab.");
  }
  afterwards.push('Deploy each app once. Nothing starts on its own until you have.');

  return {
    version: 1,
    exportedAt: Date.now(),
    derailedVersion: getSetting('version') ?? '',
    projects,
    settings: {
      appBaseDomain: getSetting(SETTINGS.appBaseDomain),
      panelDomain: getSetting(SETTINGS.panelDomain),
    },
    afterwards,
  };
}

/**
 * Builds the file to carry across: the plan, plus a backup of every project.
 *
 * The backups are the ordinary ones, so this file is also a complete, openable copy
 * of everything on the machine even if nobody ever imports it anywhere.
 */
export async function exportInstall(
  onLine?: (line: string) => void,
): Promise<{ file: string; sizeBytes: number }> {
  const work = join(paths.dataDir, `.moving-${Date.now()}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'backups'), { recursive: true });

  const plan = describeInstall();
  await Bun.write(join(work, 'derailed.json'), JSON.stringify(plan, null, 2));

  for (const project of listProjects()) {
    onLine?.(`Backing up ${project.name}…`);
    try {
      const backup = await createBackup(project.id);
      const source = join(paths.dataDir, 'backups', `${backup.id}.tar.gz`);
      await Bun.write(join(work, 'backups', `${project.slug}.tar.gz`), Bun.file(source));
    } catch (err) {
      onLine?.(
        `Could not back up ${project.name}: ${err instanceof Error ? err.message : err}. Carrying on.`,
      );
    }
  }

  await Bun.write(
    join(work, 'README.txt'),
    [
      'This is a complete copy of a Derailed server.',
      '',
      'derailed.json  what was set up: projects, apps, databases, domains, storage',
      'backups/       one ordinary .tar.gz per project, openable with tar',
      '',
      'To move in: on the new server, Settings, Move in, and upload this file.',
      '',
      'Variable values are deliberately not in here. They are encrypted with a key',
      'that stays on the old machine, and putting them in a file somebody emails',
      'themselves would undo the reason they were encrypted in the first place.',
      '',
    ].join('\n'),
  );

  await mkdir(join(paths.dataDir, 'backups'), { recursive: true });
  const file = join(paths.dataDir, 'backups', `derailed-move-${Date.now()}.tar.gz`);

  const proc = Bun.spawn(['tar', '-czf', file, '-C', work, '.'], { stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  await rm(work, { recursive: true, force: true });
  if (code !== 0) throw new Error(`Could not build the file. ${stderr}`.trim());

  const info = await stat(file);
  return { file, sizeBytes: info.size };
}

export interface ImportResult {
  projects: number;
  services: number;
  domains: number;
  /** What still has to be done by hand, said plainly. */
  afterwards: string[];
  warnings: string[];
}

/**
 * Recreates everything the plan describes, without starting any of it.
 *
 * Nothing is deployed. An app that came across pointing at a repository will build
 * when somebody asks it to, and not before: importing a plan should never be the
 * moment a new machine starts pulling images and taking traffic.
 *
 * Anything that already exists is skipped rather than merged. Importing twice, or
 * importing onto a machine that is already doing something, must not quietly change
 * what is there.
 */
export function importInstall(plan: MigrationPlan): ImportResult {
  if (plan.version !== 1) {
    throw new Error('That file came from a version of Derailed this one does not understand.');
  }

  const result: ImportResult = {
    projects: 0,
    services: 0,
    domains: 0,
    afterwards: plan.afterwards ?? [],
    warnings: [],
  };

  for (const incoming of plan.projects ?? []) {
    if (findProjectBySlug(incoming.slug)) {
      result.warnings.push(`Skipped ${incoming.name}: a project by that name is already here.`);
      continue;
    }

    const project = createProject(incoming.name);
    result.projects++;

    for (const service of incoming.services ?? []) {
      if (findServiceBySlug(project.id, service.slug)) continue;

      const created =
        service.kind === 'database'
          ? createDatabaseService({
              projectId: project.id,
              name: service.name,
              engine: service.dbEngine ?? 'postgres',
              version: service.dbVersion ?? '16',
              dbName: service.dbName ?? 'app',
              dbUser: service.dbUser ?? 'app',
              // A fresh one. The old password is not in the file, and a database
              // restored from the backup will be given this one when it starts.
              dbPassword: crypto.randomUUID().replace(/-/g, ''),
              port: service.port ?? 5432,
            })
          : createAppService({
              projectId: project.id,
              name: service.name,
              source: (service.source as 'repo' | 'image' | 'upload') ?? 'repo',
              image: service.image,
              repoUrl: service.repoUrl,
              branch: service.branch,
              rootDir: service.rootDir,
              buildStrategy: (service.buildStrategy as 'auto') ?? 'auto',
              dockerfilePath: service.dockerfilePath,
              port: service.port,
              healthPath: service.healthPath,
            });
      result.services++;

      for (const path of service.volumes ?? []) createVolume(created.id, path);

      // Names with empty values, so the Variables tab shows exactly what has to be
      // filled in rather than leaving somebody to work it out from the old server.
      if (service.variableNames?.length) {
        replaceUserEnv(
          created.id,
          service.variableNames.map((key) => ({ key, value: '' })),
        );
      }

      for (const domain of service.domains ?? []) {
        if (domain.kind !== 'custom') continue;
        try {
          createDomain(
            created.id,
            domain.hostname,
            'custom',
            'unchecked',
            'pending',
            domain.pathPrefix,
          );
          result.domains++;
        } catch {
          result.warnings.push(`${domain.hostname} is already here, so it was left alone.`);
        }
      }
    }
  }

  if (plan.settings?.appBaseDomain) {
    setSetting(SETTINGS.appBaseDomain, plan.settings.appBaseDomain);
  }

  return result;
}
