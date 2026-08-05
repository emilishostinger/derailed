import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { FriendlyError } from '../build/git.ts';
import { credentialsFor } from '../catalog/create.ts';
import { findEngine } from '../catalog/databases.ts';
import { paths } from '../config.ts';
import { findProject, listProjects } from '../db/repo/projects.ts';
import { listServices } from '../db/repo/services.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { listVolumesFor } from '../db/repo/volumes.ts';
import {
  createContainer,
  destroyContainer,
  inspectContainer,
  listContainers,
  startContainer,
  stopContainer,
} from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { LABELS, labelFilter, managedLabels } from '../docker/labels.ts';

/**
 * Backups.
 *
 * A backup is a plain tar.gz per project containing a readable manifest, a SQL dump
 * per database, and a tar of every stored folder. Ordinary formats on purpose: if
 * Derailed ever goes away, or someone wants to move to another machine, everything in
 * here can be opened with tools they already have.
 */
export interface BackupManifest {
  version: 1;
  createdAt: number;
  projectName: string;
  projectSlug: string;
  databases: { service: string; engine: string; version: string; file: string }[];
  volumes: { service: string; path: string; file: string }[];
  /** Anything worth knowing about this copy, in plain language. */
  warnings?: string[];
}

export interface BackupSummary {
  id: string;
  projectId: string;
  projectName: string;
  createdAt: number;
  sizeBytes: number;
  databases: number;
  volumes: number;
  warnings?: string[];
}

/** A tiny image that has tar, used to read and write volume contents. */
const HELPER_IMAGE = 'alpine:3.20';

export function backupsDir(): string {
  return join(paths.dataDir, 'backups');
}

function backupPath(id: string): string {
  return join(backupsDir(), `${id}.tar.gz`);
}

async function run(cmd: string[], timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out: out + err };
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/**
 * Runs a command inside a container and writes its stdout to a file.
 *
 * Uses `docker exec` through the CLI rather than the API: the API's exec stream is
 * multiplexed and hijacked, and for a plain dump-to-file the CLI is both simpler and
 * exactly as reliable.
 */
async function execToFile(containerId: string, cmd: string[], file: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'exec', containerId, ...cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [body, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new FriendlyError(
      "Derailed couldn't read that database to back it up.",
      'It may still be starting. Try again in a moment.',
      stderr.split('\n').filter(Boolean).slice(-5),
    );
  }
  await Bun.write(file, new Uint8Array(body));
}

function dumpCommand(
  engine: string,
  credentials: { user: string; dbName: string; password: string },
) {
  if (engine === 'postgres') {
    return {
      cmd: [
        'sh',
        '-c',
        `PGPASSWORD='${credentials.password}' pg_dump -U '${credentials.user}' '${credentials.dbName}'`,
      ],
      file: 'dump.sql',
    };
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    return {
      cmd: [
        'sh',
        '-c',
        `mysqldump -u '${credentials.user}' -p'${credentials.password}' --single-transaction --routines '${credentials.dbName}'`,
      ],
      file: 'dump.sql',
    };
  }
  if (engine === 'redis') {
    // Redis has no textual dump; the append-only log is the honest thing to keep.
    return { cmd: ['sh', '-c', 'redis-cli --rdb /dev/stdout 2>/dev/null'], file: 'dump.rdb' };
  }
  return null;
}

/** A tar holding one empty directory. Anything at or below this holds no files. */
const EMPTY_TAR_BYTES = 4096;

/** Whether the volume Derailed knows about is really mounted into the container. */
async function volumeIsAttached(serviceId: string, volumeName: string): Promise<boolean> {
  const containerId = await runningContainer(serviceId);
  if (!containerId) return false;
  const inspected = await inspectContainer(containerId).catch(() => null);
  const mounts = (inspected as { Mounts?: { Name?: string }[] } | null)?.Mounts ?? [];
  return mounts.some((mount) => mount.Name === volumeName);
}

async function ensureHelper(): Promise<void> {
  if (!(await imageExists(HELPER_IMAGE))) await pullImage(HELPER_IMAGE);
}

/**
 * Runs one throwaway container with a volume on /data and a host folder on /xfer.
 *
 * Both halves of this used to pipe the tar through the container's stdin or stdout.
 * That is where a backup can quietly turn into nothing: if the stream ends early the
 * container still exits zero, and an empty tar looks exactly like a successful one.
 * Handing the file over as a bind mount means the tar is written to disk by tar
 * itself, and a failure is a non-zero exit code rather than a short file.
 */
async function runHelper(
  volumeName: string,
  hostDir: string,
  script: string,
): Promise<{ code: number; out: string }> {
  await ensureHelper();
  const helper = `derailed-vol-${Math.random().toString(36).slice(2, 8)}`;
  const id = await createContainer({
    name: helper,
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', script],
    volumes: { [volumeName]: '/data', [hostDir]: '/xfer' },
    labels: managedLabels({ role: 'build' }),
    restartPolicy: 'no',
  });
  try {
    const proc = Bun.spawn(['docker', 'start', '-a', id], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: `${out}${err}`.trim() };
  } finally {
    await destroyContainer(id, 2).catch(() => undefined);
  }
}

/** Copies a Docker volume's contents out as a tar. Returns how many bytes landed. */
async function exportVolume(volumeName: string, target: string): Promise<number> {
  const dir = dirname(target);
  const file = basename(target);
  const result = await runHelper(volumeName, dir, `tar cf /xfer/${file} -C /data .`);
  if (result.code !== 0) {
    throw new FriendlyError("Derailed couldn't copy the stored files.", undefined, [result.out]);
  }
  return await Bun.file(target)
    .stat()
    .then((info) => info.size)
    .catch(() => 0);
}

/**
 * Puts a tar back into a volume, replacing what is there.
 *
 * The container using the volume must be stopped first. Emptying a folder underneath
 * a running database leaves it serving from files that no longer exist: it looks fine
 * until the next restart, and then everything is gone.
 */
async function importVolume(volumeName: string, source: string): Promise<void> {
  const dir = dirname(source);
  const file = basename(source);
  const result = await runHelper(
    volumeName,
    dir,
    `set -e; rm -rf /data/* /data/.[!.]* 2>/dev/null || true; tar xf /xfer/${file} -C /data`,
  );
  if (result.code !== 0) {
    throw new FriendlyError("Derailed couldn't put those files back.", undefined, [result.out]);
  }
}

/** Stops a service's containers, does something, then starts them again. */
async function withServiceStopped<T>(serviceId: string, action: () => Promise<T>): Promise<T> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  const wasRunning = containers.filter((container) => container.State === 'running');
  for (const container of wasRunning) await stopContainer(container.Id, 20).catch(() => undefined);
  try {
    return await action();
  } finally {
    for (const container of wasRunning) await startContainer(container.Id).catch(() => undefined);
  }
}

export async function createBackup(projectId: string): Promise<BackupSummary> {
  const project = findProject(projectId);
  if (!project) throw new FriendlyError("That project doesn't exist.");

  await mkdir(backupsDir(), { recursive: true });
  const id = `${project.slug}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const work = join(paths.dataDir, 'backups', `.building-${id}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const manifest: BackupManifest = {
    version: 1,
    createdAt: Date.now(),
    projectName: project.name,
    projectSlug: project.slug,
    databases: [],
    volumes: [],
    warnings: [],
  };

  try {
    for (const service of listServices(project.id)) {
      let dumped = false;
      if (service.kind === 'database') {
        const engine = findEngine(service.dbEngine ?? '');
        const credentials = credentialsFor(service);
        const containerId = await runningContainer(service.id);
        if (!engine || !credentials || !containerId) continue;

        const dump = dumpCommand(engine.engine, credentials);
        if (!dump) continue;

        const file = `databases/${service.slug}-${dump.file}`;
        await mkdir(join(work, 'databases'), { recursive: true });
        await execToFile(containerId, dump.cmd, join(work, file));
        manifest.databases.push({
          service: service.slug,
          engine: engine.engine,
          version: service.dbVersion ?? '',
          file,
        });
        dumped = true;
      }

      for (const volume of listVolumesFor(service.id)) {
        // A database that dumped cleanly is already in the copy, in a form that opens
        // anywhere and restores into any later version. Its raw data folder would be
        // the same content again, several times the size, and far more brittle.
        if (dumped) continue;

        const file = `volumes/${service.slug}${volume.containerPath.replace(/\//g, '_')}.tar`;
        await mkdir(join(work, 'volumes'), { recursive: true });
        const bytes = await exportVolume(volume.name, join(work, file));
        manifest.volumes.push({ service: service.slug, path: volume.containerPath, file });

        // An empty tar is a handful of bytes. Saying so is the whole point: a backup
        // nobody questions is the one that turns out to be empty on the day it matters.
        if (bytes <= EMPTY_TAR_BYTES) {
          const attached = await volumeIsAttached(service.id, volume.name);
          manifest.warnings?.push(
            attached
              ? `Nothing was stored in ${service.name} at ${volume.containerPath} yet, so that folder is empty in this copy.`
              : `${service.name} has storage set up at ${volume.containerPath}, but it is not in use until the app is deployed again. Nothing from that folder is in this copy.`,
          );
        }
      }
    }

    await Bun.write(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const archive = backupPath(id);
    const tar = await run(['tar', '-czf', archive, '-C', work, '.']);
    if (tar.code !== 0) {
      throw new FriendlyError("Derailed couldn't package the backup.", undefined, [tar.out]);
    }

    // Beside the archive, so listing never has to unpack one.
    await Bun.write(manifestPath(id), JSON.stringify(manifest)).catch(() => undefined);

    const size = (await stat(archive)).size;
    return {
      id,
      projectId: project.id,
      projectName: project.name,
      createdAt: manifest.createdAt,
      sizeBytes: size,
      databases: manifest.databases.length,
      volumes: manifest.volumes.length,
      warnings: manifest.warnings,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The manifest, without unpacking the archive.
 *
 * Written beside each backup when it is made. Listing used to shell out to tar once
 * per file, which is a second of work each on a big archive: fine for three backups,
 * a page that takes half a minute to answer once there are fifty. Archives made
 * before this existed are read the slow way once, then get a copy for next time.
 */
function manifestPath(id: string): string {
  return join(backupsDir(), `${id}.json`);
}

async function readManifest(id: string): Promise<BackupManifest | null> {
  const beside = Bun.file(manifestPath(id));
  if (await beside.exists()) {
    return (await beside.json().catch(() => null)) as BackupManifest | null;
  }

  const peek = await run(['tar', '-xzOf', backupPath(id), './manifest.json'], 60_000);
  try {
    const manifest = JSON.parse(peek.out) as BackupManifest;
    await Bun.write(manifestPath(id), JSON.stringify(manifest)).catch(() => undefined);
    return manifest;
  } catch {
    return null;
  }
}

export async function listBackups(): Promise<BackupSummary[]> {
  await mkdir(backupsDir(), { recursive: true });
  const files = (await readdir(backupsDir())).filter((name) => name.endsWith('.tar.gz'));
  const projects = listProjects();

  const summaries = await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.tar\.gz$/, '');
      const info = await stat(join(backupsDir(), file)).catch(() => null);
      if (!info) return null;

      const manifest = await readManifest(id);
      const project = manifest
        ? projects.find((entry) => entry.slug === manifest.projectSlug)
        : undefined;

      return {
        id,
        projectId: project?.id ?? '',
        projectName: manifest?.projectName ?? id,
        createdAt: manifest?.createdAt ?? info.mtimeMs,
        sizeBytes: info.size,
        databases: manifest?.databases.length ?? 0,
        volumes: manifest?.volumes.length ?? 0,
        warnings: manifest?.warnings,
      } satisfies BackupSummary;
    }),
  );

  return summaries.filter((entry) => entry !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export function backupFile(id: string): string {
  // Ids come from our own filenames, but never build a path from user input unchecked.
  if (!/^[a-z0-9-]+$/i.test(id)) throw new FriendlyError('That is not a backup name.');
  return backupPath(id);
}

export async function deleteBackup(id: string): Promise<void> {
  await rm(backupFile(id), { force: true });
  await rm(manifestPath(id), { force: true }).catch(() => undefined);
}

export interface RestoreReport {
  databases: number;
  volumes: number;
  warnings: string[];
}

/**
 * Puts a backup back.
 *
 * Restores into the services that exist now, matched by slug. Anything in the backup
 * with no matching service is reported rather than silently skipped, because a partial
 * restore someone doesn't know about is worse than a failed one.
 */
export async function restoreBackup(id: string, projectId: string): Promise<RestoreReport> {
  const project = findProject(projectId);
  if (!project) throw new FriendlyError("That project doesn't exist.");

  const archive = backupFile(id);
  if (!(await Bun.file(archive).exists())) throw new FriendlyError("That backup doesn't exist.");

  const work = join(paths.dataDir, 'backups', `.restoring-${id}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const report: RestoreReport = { databases: 0, volumes: 0, warnings: [] };

  try {
    const extract = await run(['tar', '-xzf', archive, '-C', work]);
    if (extract.code !== 0) throw new FriendlyError("Derailed couldn't open that backup.");

    const manifest = JSON.parse(
      await Bun.file(join(work, 'manifest.json')).text(),
    ) as BackupManifest;
    const services = listServices(project.id);

    for (const entry of manifest.databases) {
      const service = services.find(
        (candidate) => candidate.slug === entry.service && candidate.kind === 'database',
      );
      if (!service) {
        report.warnings.push(`No database called ${entry.service} here, so it was skipped.`);
        continue;
      }
      const containerId = await runningContainer(service.id);
      const credentials = credentialsFor(service);
      if (!containerId || !credentials) {
        report.warnings.push(`${service.name} is not running, so it was skipped.`);
        continue;
      }

      const dump = join(work, entry.file);
      const restore =
        entry.engine === 'postgres'
          ? `PGPASSWORD='${credentials.password}' psql -U '${credentials.user}' -d '${credentials.dbName}'`
          : entry.engine === 'mysql' || entry.engine === 'mariadb'
            ? `mysql -u '${credentials.user}' -p'${credentials.password}' '${credentials.dbName}'`
            : null;

      if (!restore) {
        report.warnings.push(`Derailed can't restore ${entry.engine} yet, so it was skipped.`);
        continue;
      }

      const proc = Bun.spawn(['docker', 'exec', '-i', containerId, 'sh', '-c', restore], {
        stdin: Bun.file(dump),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) {
        report.warnings.push(`${service.name} did not restore cleanly: ${stderr.slice(0, 200)}`);
        continue;
      }
      report.databases++;
    }

    for (const entry of manifest.volumes) {
      const service = services.find((candidate) => candidate.slug === entry.service);
      if (!service) {
        report.warnings.push(`No app called ${entry.service} here, so its files were skipped.`);
        continue;
      }
      const volume = listVolumesFor(service.id).find(
        (candidate) => candidate.containerPath === entry.path,
      );
      if (!volume) {
        report.warnings.push(
          `${service.name} has no storage at ${entry.path} any more, so those files were skipped.`,
        );
        continue;
      }
      // Stopped first, always. Replacing a folder under a running app is how a
      // restore turns into the outage it was supposed to prevent.
      await withServiceStopped(service.id, () => importVolume(volume.name, join(work, entry.file)));
      report.volumes++;
    }

    return report;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface Retention {
  /** Newest kept per project. */
  keep: number;
  /** Older than this many days goes, whatever the count. 0 means no age limit. */
  keepDays: number;
}

export const DEFAULT_RETENTION: Retention = { keep: 7, keepDays: 0 };

export function retention(): Retention {
  const keep = Number(getSetting(SETTINGS.backupKeep) ?? '');
  const keepDays = Number(getSetting(SETTINGS.backupKeepDays) ?? '');
  return {
    keep: Number.isFinite(keep) && keep > 0 ? Math.min(keep, 100) : DEFAULT_RETENTION.keep,
    keepDays: Number.isFinite(keepDays) && keepDays > 0 ? Math.min(keepDays, 3650) : 0,
  };
}

export function setRetention(next: Partial<Retention>): Retention {
  if (next.keep !== undefined) setSetting(SETTINGS.backupKeep, String(next.keep));
  if (next.keepDays !== undefined) setSetting(SETTINGS.backupKeepDays, String(next.keepDays));
  return retention();
}

/**
 * Throws away the copies nobody asked to keep.
 *
 * Two limits rather than one: a count, because that is what people picture, and an
 * age, because "keep the last seven" on a project backed up hourly is three hours of
 * history. Whichever removes a backup first wins.
 */
export async function pruneBackups(limits: Retention = retention()): Promise<number> {
  const all = await listBackups();
  const byProject = new Map<string, BackupSummary[]>();
  for (const backup of all) {
    const list = byProject.get(backup.projectName) ?? [];
    list.push(backup);
    byProject.set(backup.projectName, list);
  }

  const oldest = limits.keepDays > 0 ? Date.now() - limits.keepDays * 24 * 60 * 60 * 1000 : 0;

  let removed = 0;
  for (const list of byProject.values()) {
    for (const [index, backup] of list.entries()) {
      // The newest is never removed on age alone. Waking up to no backups at all
      // because nothing changed for a month is not what anyone meant by "keep 30 days".
      const tooMany = index >= limits.keep;
      const tooOld = index > 0 && oldest > 0 && backup.createdAt < oldest;
      if (!tooMany && !tooOld) continue;
      await deleteBackup(backup.id).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
