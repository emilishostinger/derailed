import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FriendlyError } from '../build/git.ts';
import { credentialsFor } from '../catalog/create.ts';
import { findEngine } from '../catalog/databases.ts';
import { paths } from '../config.ts';
import { db } from '../db/index.ts';
import { findService, listServices } from '../db/repo/services.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { newId } from '../util/ids.ts';
import { dumpCommandFor, execArgs, restoreCommandFor } from './backup.ts';

/**
 * Copies of one database, often.
 *
 * "The bad thing happened at three o'clock and the backup is from midnight" is the
 * worst hour of somebody's month, and the answer is not a better nightly backup. It
 * is more of them.
 *
 * **This is not point-in-time recovery**, and the screen says so. Real PITR replays a
 * write-ahead log to an arbitrary second, needs the database configured to archive
 * that log, and exists for PostgreSQL and MySQL and not for the other four engines
 * here. This restores the nearest copy at or before the moment you name, so the
 * question it answers is "how much do I lose", and the answer is "up to one interval"
 * rather than "up to a day".
 */

export interface Snapshot {
  id: string;
  serviceId: string;
  at: number;
  sizeBytes: number;
}

interface SnapshotRow {
  id: string;
  service_id: string;
  at: number;
  size_bytes: number;
  file: string;
}

/** Two days at hourly, which is the shortest interval offered. */
const KEEP = 48;

export const INTERVALS = [1, 6, 12] as const;
export type SnapshotInterval = (typeof INTERVALS)[number];

function snapshotPath(file: string): string {
  if (!/^[a-z0-9.-]+$/i.test(file)) throw new FriendlyError('That is not a snapshot name.');
  return join(paths.snapshots, file);
}

export function listSnapshots(serviceId: string): Snapshot[] {
  return db()
    .query<SnapshotRow, [string]>(
      'SELECT * FROM db_snapshots WHERE service_id = ? ORDER BY at DESC',
    )
    .all(serviceId)
    .map((row) => ({
      id: row.id,
      serviceId: row.service_id,
      at: row.at,
      sizeBytes: row.size_bytes,
    }));
}

/**
 * The copy to restore for a given moment: the newest one taken at or before it.
 *
 * Never a later one, however much closer in time it might be. A copy from after the
 * moment you named contains the thing you are trying to undo, which is the one
 * outcome worse than restoring nothing.
 */
export function snapshotAt(serviceId: string, moment: number): Snapshot | null {
  const row = db()
    .query<SnapshotRow, [string, number]>(
      'SELECT * FROM db_snapshots WHERE service_id = ? AND at <= ? ORDER BY at DESC LIMIT 1',
    )
    .get(serviceId, moment);
  return row
    ? { id: row.id, serviceId: row.service_id, at: row.at, sizeBytes: row.size_bytes }
    : null;
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/** Takes one now. Returns null when the database is not in a state to be read. */
export async function takeSnapshot(serviceId: string): Promise<Snapshot | null> {
  const service = findService(serviceId);
  if (service?.kind !== 'database') return null;

  const engine = findEngine(service.dbEngine ?? '');
  const credentials = credentialsFor(service);
  const containerId = await runningContainer(serviceId);
  if (!engine || !credentials || !containerId) return null;

  const plan = dumpCommandFor(engine.engine, credentials, { replace: true });
  if (!plan) return null;

  await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
  const id = newId();
  const file = `${id}-${plan.file}`;
  const target = snapshotPath(file);

  if (plan.prepare) {
    const ready = Bun.spawn(['docker', ...execArgs(containerId, plan.env), ...plan.prepare], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if ((await ready.exited) !== 0) return null;
  }

  const proc = Bun.spawn(['docker', ...execArgs(containerId, plan.env), ...plan.cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [body, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (code !== 0) return null;

  await Bun.write(target, body);
  const size = (await stat(target)).size;

  db()
    .query('INSERT INTO db_snapshots (id, service_id, at, size_bytes, file) VALUES (?, ?, ?, ?, ?)')
    .run(id, serviceId, Date.now(), size, file);

  await pruneSnapshots(serviceId);
  return { id, serviceId, at: Date.now(), sizeBytes: size };
}

/** Keeps the newest few and deletes the rest, file and row together. */
export async function pruneSnapshots(serviceId: string): Promise<void> {
  const stale = db()
    .query<SnapshotRow, [string, number]>(
      'SELECT * FROM db_snapshots WHERE service_id = ? ORDER BY at DESC LIMIT -1 OFFSET ?',
    )
    .all(serviceId, KEEP);

  for (const row of stale) {
    await rm(snapshotPath(row.file), { force: true }).catch(() => undefined);
    db().query('DELETE FROM db_snapshots WHERE id = ?').run(row.id);
  }
}

/**
 * Puts one back.
 *
 * The same route a project restore takes, into the database's own client, so anything
 * that works for one works for the other. Redis and Valkey are refused: their dump is
 * a binary snapshot the server reads at startup and there is no way to feed one to a
 * running instance, which the backups page already says about them.
 */
export async function restoreSnapshot(snapshotId: string): Promise<void> {
  const row = db()
    .query<SnapshotRow, [string]>('SELECT * FROM db_snapshots WHERE id = ?')
    .get(snapshotId);
  if (!row) throw new FriendlyError('That copy is no longer here.');

  const service = findService(row.service_id);
  const engine = findEngine(service?.dbEngine ?? '');
  const credentials = service && credentialsFor(service);
  const containerId = await runningContainer(row.service_id);
  if (!service || !engine || !credentials || !containerId) {
    throw new FriendlyError(
      'That database is not running, so there is nothing to restore into.',
      'Start it first.',
    );
  }

  const plan = restoreCommandFor(engine.engine, credentials);
  if (!plan) {
    throw new FriendlyError(
      `A ${engine.label} copy cannot be put back into a running server.`,
      'Its dump is the file the server reads when it starts, not something it can be given while running.',
    );
  }

  /**
   * Stop at the first real problem, rather than carrying on to the end.
   *
   * `psql` reads a script and by default treats every statement as independent, so a
   * restore that could not do half of what it was asked still exits zero and reports
   * success. The drops in the dump mean there is nothing left to fail harmlessly, so
   * anything that does fail now is worth stopping for.
   */
  const cmd =
    plan.cmd[0] === 'psql'
      ? [plan.cmd[0], '-v', 'ON_ERROR_STOP=1', ...plan.cmd.slice(1)]
      : plan.cmd;

  // `-i`, or `docker exec` gives the client no standard input: `psql` reads an empty
  // script, does nothing, and exits zero. A restore that reports success and changed
  // nothing is worse than one that fails, and this is the flag between the two.
  const proc = Bun.spawn(['docker', ...execArgs(containerId, plan.env, ['-i']), ...cmd], {
    stdin: Bun.file(snapshotPath(row.file)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [problem, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new FriendlyError(
      'Putting that copy back did not work.',
      'The database is where it was; nothing has been half-applied.',
      problem.split('\n').filter(Boolean).slice(-5),
    );
  }
}

/**
 * Takes whatever is due.
 *
 * Checked every ten minutes rather than scheduled per database: a timer per database
 * is a timer to cancel when one is deleted, and this is one loop that asks.
 */
export async function sweepSnapshots(): Promise<void> {
  for (const service of listServices()) {
    if (service.kind !== 'database' || !service.snapshotEveryHours) continue;

    const newest = listSnapshots(service.id)[0];
    const due = !newest || Date.now() - newest.at >= service.snapshotEveryHours * 60 * 60 * 1000;
    if (due) await takeSnapshot(service.id).catch(() => undefined);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSnapshots(): void {
  if (timer) return;
  timer = setInterval(() => void sweepSnapshots(), 10 * 60_000);
  timer.unref?.();
}

export function stopSnapshots(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
