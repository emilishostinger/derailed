import type { PitrState, Service } from '@derailed/shared';
import { execArgs } from '../backup/backup.ts';
import { FriendlyError } from '../build/git.ts';
import { db } from '../db/index.ts';
import { createDbUpgrade, updateDbUpgrade } from '../db/repo/dbupgrades.ts';
import { findProject } from '../db/repo/projects.ts';
import { containerName, findService, updateService } from '../db/repo/services.ts';
import {
  createContainer,
  destroyContainer,
  findContainerByName,
  inspectContainer,
  listContainers,
  renameContainer,
  startContainer,
  stopContainer,
} from '../docker/containers.ts';
import { LABELS, labelFilter, managedLabels } from '../docker/labels.ts';
import { removeVolume } from '../docker/volumes.ts';
import { emitService } from '../runtime/present.ts';
import { credentialsFor, startDatabaseContainer } from './create.ts';
import { findEngine } from './databases.ts';

/**
 * Point-in-time restore for Postgres, honestly scoped.
 *
 * Hourly copies bound the loss window for every engine; this shrinks it to
 * about a minute, for the one engine that does it well, and says which. Postgres
 * archives every filled write-ahead-log segment into a second volume, a full base
 * copy is taken daily, and a restore replays the log to the exact moment named.
 *
 * The other engines do not get a version of this, on purpose. MySQL's binlog
 * story is real but different machinery; the rest have nothing honest to offer.
 * A feature that says "point in time" and means "nearest copy" is the kind of
 * promise this product exists not to make.
 *
 * Numbers, said plainly: segments are forced out at least every 60 seconds
 * (`archive_timeout`), so the most a restore can lose is about a minute. A
 * deliberate restore first flushes the log completely, so it loses nothing at
 * all up to the moment it names.
 */

export const WAL_MOUNT = '/wal-archive';

export function walVolumeName(serviceId: string): string {
  return `derailed-w-${serviceId}`;
}

/**
 * The server arguments that turn archiving on.
 *
 * The archive command refuses to overwrite a different file but accepts the
 * identical one: after an unclean stop Postgres re-archives its last segment,
 * and a command strict about that wedges the archiver for ever, quietly.
 */
export function postgresWalArgs(): string[] {
  return [
    'postgres',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    `archive_command=test ! -f ${WAL_MOUNT}/%f && cp %p ${WAL_MOUNT}/%f || cmp -s %p ${WAL_MOUNT}/%f`,
    '-c',
    'archive_timeout=60',
  ];
}

const PGDATA = '/var/lib/postgresql/data/pgdata';
const KEEP_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;

async function runIn(
  containerId: string,
  cmd: string[],
  env: string[] = [],
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['docker', ...execArgs(containerId, env), ...cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}`.trim() };
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

function requirePostgres(serviceId: string): Service {
  const service = findService(serviceId);
  if (service?.kind !== 'database') throw new FriendlyError('That database no longer exists.');
  if (service.dbEngine !== 'postgres') {
    throw new FriendlyError(
      'Point-in-time restore is for PostgreSQL.',
      'Every database still has hourly copies, which bound how much an accident can cost.',
    );
  }
  return service;
}

async function waitHealthy(containerId: string, timeoutMs = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = await inspectContainer(containerId).catch(() => null);
    const state = (
      inspected as { State?: { Health?: { Status?: string }; Running?: boolean } } | null
    )?.State;
    if (state?.Health?.Status === 'healthy') return true;
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * A full copy of the database into the archive volume, tarred and stamped with
 * the moment it finished. `-X fetch` folds the log the copy needs into the tar,
 * so each base copy restores on its own even if the archive around it is gone.
 */
export async function takeBaseBackup(serviceId: string): Promise<number> {
  const service = requirePostgres(serviceId);
  const credentials = credentialsFor(service);
  const containerId = await runningContainer(serviceId);
  if (!credentials || !containerId) {
    throw new FriendlyError('The database is not running, so a base copy cannot be taken.');
  }

  const scratch = `${WAL_MOUNT}/base-taking`;
  await runIn(containerId, ['rm', '-rf', scratch]);
  const made = await runIn(
    containerId,
    ['pg_basebackup', '-U', credentials.user, '-D', scratch, '-Ft', '-z', '-X', 'fetch'],
    [`PGPASSWORD=${credentials.password}`],
  );
  if (made.code !== 0) {
    await runIn(containerId, ['rm', '-rf', scratch]);
    throw new FriendlyError('The base copy did not complete.', undefined, [made.out.slice(-300)]);
  }
  const at = Date.now();
  const moved = await runIn(containerId, ['mv', scratch, `${WAL_MOUNT}/base-${at}`]);
  if (moved.code !== 0) throw new FriendlyError('The base copy could not be stamped.');
  await pruneArchive(serviceId).catch(() => undefined);
  return at;
}

/** The stamped base copies, oldest first. */
async function listBases(containerId: string): Promise<number[]> {
  const listed = await runIn(containerId, ['ls', '-1', WAL_MOUNT]);
  if (listed.code !== 0) return [];
  return listed.out
    .split('\n')
    .map((line) => /^base-(\d+)$/.exec(line.trim())?.[1])
    .filter((stamp): stamp is string => !!stamp)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Keeps a week of restore range and throws away the rest: base copies older than
 * the window (always keeping the newest that is older, so the whole window stays
 * restorable) and any log segment older than the oldest kept base.
 */
export async function pruneArchive(serviceId: string): Promise<void> {
  const containerId = await runningContainer(serviceId);
  if (!containerId) return;
  const bases = await listBases(containerId);
  const cutoff = Date.now() - KEEP_ARCHIVE_MS;
  // The newest base at-or-before the cutoff anchors the window; older ones go.
  const anchorIndex = bases.findLastIndex((at) => at <= cutoff);
  for (const at of bases.slice(0, Math.max(0, anchorIndex))) {
    await runIn(containerId, ['rm', '-rf', `${WAL_MOUNT}/base-${at}`]);
  }
  const oldestKept = bases[Math.max(0, anchorIndex)] ?? bases[0];
  if (oldestKept) {
    // Segments and history files older than the oldest kept base serve no restore.
    await runIn(containerId, [
      'find',
      WAL_MOUNT,
      '-maxdepth',
      '1',
      '-type',
      'f',
      '!',
      '-newer',
      `${WAL_MOUNT}/base-${oldestKept}`,
      '-delete',
    ]);
  }
}

/** What the Copies tab shows beside the toggle. */
export async function pitrState(serviceId: string): Promise<PitrState> {
  const service = findService(serviceId);
  if (service?.kind !== 'database') throw new FriendlyError('That database no longer exists.');
  if (service.dbEngine !== 'postgres') {
    return { supported: false, enabled: false, oldestMoment: null, sizeBytes: 0 };
  }
  if (!service.walArchive) {
    return { supported: true, enabled: false, oldestMoment: null, sizeBytes: 0 };
  }
  const containerId = await runningContainer(serviceId);
  if (!containerId) return { supported: true, enabled: true, oldestMoment: null, sizeBytes: 0 };
  const bases = await listBases(containerId);
  const size = await runIn(containerId, ['du', '-sk', WAL_MOUNT]);
  const kb = Number(size.out.split(/\s+/)[0] ?? 0);
  return {
    supported: true,
    enabled: true,
    oldestMoment: bases[0] ?? null,
    sizeBytes: Number.isFinite(kb) ? kb * 1024 : 0,
  };
}

/**
 * Turns the archive on or off. Either way the container is rebuilt, because
 * archiving is a server argument, and the data volume never moves.
 */
export async function setPitr(serviceId: string, enabled: boolean): Promise<PitrState> {
  const service = requirePostgres(serviceId);
  if (!!service.walArchive === enabled) return pitrState(serviceId);

  const project = findProject(service.projectId)!;
  const stableName = containerName(project.slug, service.slug);

  updateService(serviceId, { walArchive: enabled });
  try {
    const existing = await findContainerByName(stableName);
    if (existing) await destroyContainer(existing.Id, 30);
    const containerId = await startDatabaseContainer(serviceId);
    if (!(await waitHealthy(containerId))) {
      throw new FriendlyError('The database did not come back healthy.');
    }
    if (enabled) {
      // A fresh volume belongs to root; the archiver runs as postgres. Without
      // this the archive fails quietly on every segment, which is the worst kind
      // of enabled.
      await runIn(containerId, ['chown', 'postgres:postgres', WAL_MOUNT]);
      await takeBaseBackup(serviceId);
    }
  } catch (err) {
    // Put the setting back and bring the database up the way it was.
    updateService(serviceId, { walArchive: !enabled });
    const half = await findContainerByName(stableName);
    if (half) await destroyContainer(half.Id, 5).catch(() => undefined);
    await startDatabaseContainer(serviceId).catch(() => undefined);
    throw err instanceof FriendlyError
      ? err
      : new FriendlyError('The archive could not be switched. The database is running as before.');
  }
  if (!enabled) {
    // The archive is disk spent on history nobody wants any more.
    await removeVolume(walVolumeName(serviceId)).catch(() => undefined);
  }
  emitService(serviceId);
  return pitrState(serviceId);
}

/**
 * Winds the database back to a moment, losing nothing on the way there.
 *
 * The running server first flushes and archives its log completely, so the
 * archive holds everything up to the moment it stopped. Then the same switch an
 * upgrade does: the old engine keeps its volume, renamed and stopped for a week,
 * and a fresh volume is seeded from the newest base copy at-or-before the moment
 * and replayed forward to exactly it.
 */
export async function restoreToMoment(serviceId: string, at: number): Promise<void> {
  const service = requirePostgres(serviceId);
  if (!service.walArchive) {
    throw new FriendlyError('The point-in-time archive is not on for this database.');
  }
  if (at > Date.now()) throw new FriendlyError('That moment has not happened yet.');

  const project = findProject(service.projectId)!;
  const engine = findEngine('postgres')!;
  const credentials = credentialsFor(service);
  const stableName = containerName(project.slug, service.slug);
  const containerId = await runningContainer(serviceId);
  if (!containerId || !credentials) {
    throw new FriendlyError('The database is not running, so there is nothing to wind back.');
  }

  const bases = await listBases(containerId);
  const base = [...bases].reverse().find((stamp) => stamp <= at);
  if (!base) {
    throw new FriendlyError(
      'The archive does not reach back that far.',
      bases.length
        ? `The earliest moment it can restore to is ${new Date(bases[0]!).toLocaleString()}.`
        : 'No base copy has been taken yet.',
    );
  }

  // Flush everything: a checkpoint, then a forced segment switch, then a pause
  // for the archiver to copy the segment out. After this the archive is whole.
  await runIn(
    containerId,
    ['psql', '-U', credentials.user, '-d', credentials.dbName, '-c', 'CHECKPOINT'],
    [`PGPASSWORD=${credentials.password}`],
  );
  await runIn(
    containerId,
    ['psql', '-U', credentials.user, '-d', credentials.dbName, '-c', 'SELECT pg_switch_wal()'],
    [`PGPASSWORD=${credentials.password}`],
  );
  await Bun.sleep(2000);

  const stamp = Date.now();
  const oldName = `${stableName}-old-restore-${stamp}`;
  const oldVolume = db()
    .query<{ name: string }, [string, string]>(
      'SELECT name FROM volumes WHERE service_id = ? AND container_path = ?',
    )
    .get(service.id, engine.volumePath)?.name;
  const newVolume = `derailed-v-${service.id}-r${stamp}`;

  // The kept-for-a-week record, same table and sweep as an upgrade.
  const keep = createDbUpgrade(serviceId, service.dbVersion!, service.dbVersion!);

  const existing = await findContainerByName(stableName);
  let renamed = false;
  let seeded = false;
  try {
    await stopContainer(existing!.Id, 30);
    await renameContainer(existing!.Id, oldName);
    renamed = true;

    db()
      .query('UPDATE volumes SET name = ? WHERE service_id = ? AND container_path = ?')
      .run(newVolume, service.id, engine.volumePath);

    // Seed the fresh volume from the base copy and point it at the moment.
    // Not toISOString() as it stands: the GUC parser refuses the T and the Z,
    // which the server log calls "invalid value" and the container calls fatal.
    const target = new Date(at).toISOString().replace('T', ' ').replace('Z', '+00');
    const script = [
      'set -e',
      `mkdir -p ${PGDATA}`,
      `tar xzf ${WAL_MOUNT}/base-${base}/base.tar.gz -C ${PGDATA}`,
      `printf "restore_command = 'cp ${WAL_MOUNT}/%%f %%p'\\nrecovery_target_time = '${target}'\\nrecovery_target_action = 'promote'\\n" >> ${PGDATA}/postgresql.auto.conf`,
      `touch ${PGDATA}/recovery.signal`,
      'chown -R postgres:postgres /var/lib/postgresql/data',
      `chmod 700 ${PGDATA}`,
    ].join('\n');
    const helperName = `derailed-pitr-${stamp}`;
    const helperId = await createContainer({
      name: helperName,
      image: engine.image(service.dbVersion ?? engine.versions[0]!),
      cmd: ['sh', '-c', script],
      env: { PGDATA },
      labels: managedLabels({ serviceId: service.id, role: 'build' }),
      volumes: { [newVolume]: engine.volumePath, [walVolumeName(service.id)]: WAL_MOUNT },
      restartPolicy: 'no',
    });
    try {
      const proc = Bun.spawn(['docker', 'start', '-a', helperId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [helperOut, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) {
        throw new FriendlyError('Seeding the restore failed.', undefined, [helperOut.slice(-300)]);
      }
    } finally {
      await destroyContainer(helperId, 2).catch(() => undefined);
    }
    seeded = true;

    const fresh = await startDatabaseContainer(serviceId);
    if (!(await waitHealthy(fresh))) {
      throw new FriendlyError('The wound-back database never reported itself healthy.');
    }

    // Healthy is not finished: Postgres answers read-only while it is still
    // replaying. Done means it has reached the moment and promoted itself.
    const promotedBy = Date.now() + 120_000;
    let promoted = false;
    while (Date.now() < promotedBy) {
      const check = await runIn(
        fresh,
        [
          'psql',
          '-U',
          credentials.user,
          '-d',
          credentials.dbName,
          '-tAc',
          'SELECT pg_is_in_recovery()',
        ],
        [`PGPASSWORD=${credentials.password}`],
      );
      if (check.code === 0 && check.out.trim() === 'f') {
        promoted = true;
        break;
      }
      await Bun.sleep(1000);
    }
    if (!promoted) {
      throw new FriendlyError('The wound-back database never finished replaying to the moment.');
    }

    updateDbUpgrade(keep.id, {
      status: 'ok',
      oldContainer: oldName,
      oldVolume: oldVolume ?? null,
      cleanupAfter: Date.now() + KEEP_ARCHIVE_MS,
      message: `Wound back to ${new Date(at).toLocaleString()}. What it held a moment ago is kept, stopped, for a week.`,
      finishedAt: Date.now(),
    });

    // A restore starts a new timeline; the next restore needs a base that knows it.
    await takeBaseBackup(serviceId).catch(() => undefined);
    emitService(serviceId);
  } catch (err) {
    // Put everything back the way it was a minute ago.
    if (seeded || renamed) {
      const half = await findContainerByName(stableName);
      if (half) await destroyContainer(half.Id, 5).catch(() => undefined);
    }
    await removeVolume(newVolume).catch(() => undefined);
    if (oldVolume) {
      db()
        .query('UPDATE volumes SET name = ? WHERE service_id = ? AND container_path = ?')
        .run(oldVolume, service.id, engine.volumePath);
    }
    if (renamed) {
      await renameContainer(existing!.Id, stableName).catch(() => undefined);
      await startContainer(existing!.Id).catch(() => undefined);
    }
    updateDbUpgrade(keep.id, {
      status: 'failed',
      message: 'The restore did not complete. The database is running as it was.',
      finishedAt: Date.now(),
    });
    throw err instanceof FriendlyError
      ? err
      : new FriendlyError('The restore did not complete. The database is running as it was.');
  }
}

/** Daily: a fresh base copy per archiving database, and the window pruned. */
export async function sweepBaseBackups(): Promise<void> {
  const { listServices } = await import('../db/repo/services.ts');
  for (const service of listServices()) {
    if (service.kind !== 'database' || service.dbEngine !== 'postgres' || !service.walArchive) {
      continue;
    }
    try {
      const containerId = await runningContainer(service.id);
      if (!containerId) continue;
      const bases = await listBases(containerId);
      const newest = bases[bases.length - 1];
      if (!newest || Date.now() - newest >= 24 * 60 * 60 * 1000) {
        await takeBaseBackup(service.id);
      }
    } catch {
      // Tomorrow's sweep tries again; the WAL keeps arriving regardless.
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPitrSweep(): void {
  if (timer) return;
  timer = setInterval(() => void sweepBaseBackups(), 60 * 60 * 1000);
  timer.unref?.();
}

export function stopPitrSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
