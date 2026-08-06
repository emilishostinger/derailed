import type { Job, JobRun } from '@derailed/shared';
import { raise } from '../alerts/notify.ts';
import { db } from '../db/index.ts';
import { findService } from '../db/repo/services.ts';
import { dockerFetch, dockerJson } from '../docker/client.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { newId } from '../util/ids.ts';
import { nextRun } from './schedule.ts';

/**
 * Running things on a schedule.
 *
 * The biggest gap this filled: there was no way to run anything repeatedly, so every
 * WordPress cron, every nightly cleanup and every "email me a report" was impossible.
 *
 * A job either runs inside one of your app's containers, which is the common case and
 * means it has the app's environment and its files, or on the server itself for the
 * housekeeping that belongs to nobody in particular.
 *
 * Every run keeps what it printed. A scheduled job whose output goes nowhere is a job
 * that can be quietly failing for a month with nothing to notice.
 */

/** Long enough for a real import, short enough that a hung job is not forever. */
const TIMEOUT_MS = 30 * 60 * 1000;
/** Runs kept per job. Enough to see a pattern, few enough not to grow without bound. */
const KEEP_RUNS = 20;

interface JobRow {
  id: string;
  service_id: string | null;
  name: string;
  command: string;
  schedule: string;
  enabled: 0 | 1;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  serviceId: row.service_id,
  name: row.name,
  command: row.command,
  schedule: row.schedule,
  enabled: row.enabled === 1,
  lastRunAt: row.last_run_at,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
});

export function listJobs(serviceId?: string): Job[] {
  const rows = serviceId
    ? db()
        .query<JobRow, [string]>('SELECT * FROM jobs WHERE service_id = ? ORDER BY created_at')
        .all(serviceId)
    : db().query<JobRow, []>('SELECT * FROM jobs ORDER BY created_at').all();
  return rows.map(toJob);
}

export function findJob(id: string): Job | null {
  const row = db().query<JobRow, [string]>('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? toJob(row) : null;
}

export function createJob(input: {
  serviceId: string | null;
  name: string;
  command: string;
  schedule: string;
}): Job {
  const id = newId();
  db()
    .query(
      `INSERT INTO jobs (id, service_id, name, command, schedule, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.serviceId,
      input.name,
      input.command,
      input.schedule,
      nextRun(input.schedule),
      Date.now(),
    );
  return findJob(id)!;
}

export function updateJob(
  id: string,
  patch: { name?: string; command?: string; schedule?: string; enabled?: boolean },
): Job | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    assignments.push('name = ?');
    values.push(patch.name);
  }
  if (patch.command !== undefined) {
    assignments.push('command = ?');
    values.push(patch.command);
  }
  if (patch.schedule !== undefined) {
    // The next time is recomputed here rather than at the tick, so a schedule that
    // was changed is honoured immediately instead of after the old one fires once more.
    assignments.push('schedule = ?', 'next_run_at = ?');
    values.push(patch.schedule, nextRun(patch.schedule));
  }
  if (patch.enabled !== undefined) {
    assignments.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (!assignments.length) return findJob(id);

  db()
    .query(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return findJob(id);
}

export function deleteJob(id: string): void {
  db().query('DELETE FROM jobs WHERE id = ?').run(id);
}

export function listRuns(jobId: string, limit = KEEP_RUNS): JobRun[] {
  return db()
    .query<
      {
        id: string;
        job_id: string;
        started_at: number;
        finished_at: number | null;
        exit_code: number | null;
        output: string | null;
        trigger: string;
      },
      [string, number]
    >('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(jobId, limit)
    .map((row) => ({
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      output: row.output,
      trigger: row.trigger === 'manual' ? 'manual' : 'schedule',
    }));
}

/**
 * Runs a command inside a container and collects what it printed.
 *
 * Uses the non-interactive exec path rather than the terminal's: there is nobody to
 * type at it, the output is wanted as a lump rather than a stream, and a TTY would
 * mix stdout and stderr together with escape codes in it.
 */
async function execInContainer(
  containerId: string,
  command: string,
): Promise<{ exitCode: number; output: string }> {
  const { Id } = await dockerJson<{ Id: string }>(`/containers/${containerId}/exec`, {
    method: 'POST',
    json: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      // Through a shell, because a job is a command line as somebody would type it,
      // pipes and all, not an argv the dashboard could sensibly ask them to split up.
      Cmd: ['/bin/sh', '-c', command],
    },
  });

  const response = await dockerFetch(`/exec/${Id}/start`, {
    method: 'POST',
    json: { Detach: false, Tty: false },
    timeoutMs: TIMEOUT_MS,
  });

  const output = demultiplex(new Uint8Array(await response.arrayBuffer()));
  const inspected = await dockerJson<{ ExitCode: number | null }>(`/exec/${Id}/json`);
  return { exitCode: inspected.ExitCode ?? 0, output };
}

/**
 * Docker's stream format, when there is no TTY.
 *
 * Without a TTY, stdout and stderr are interleaved as frames: one byte saying which
 * stream, three padding bytes, four bytes of big-endian length, then the payload.
 * Handed straight to a person, that header shows up as stray control characters at
 * the start of every few lines.
 *
 * Both streams are kept and in order, because for a job the interesting output is
 * very often the error.
 */
export function demultiplex(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  // A stream that does not start with a plausible frame header is one Docker sent
  // raw, which happens for older daemons and when a TTY was allocated after all.
  const looksFramed = bytes.length >= 8 && bytes[0] !== undefined && bytes[0] <= 2;
  if (!looksFramed) return decoder.decode(bytes);

  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
    const length = view.getUint32(0, false);
    const start = offset + 8;
    const end = Math.min(start + length, bytes.length);
    parts.push(decoder.decode(bytes.subarray(start, end)));
    offset = end;
    // A length of zero would spin here for ever on a malformed stream.
    if (length === 0 && end === start) break;
  }
  return parts.join('');
}

/** Runs a command on the server itself, for the housekeeping that belongs to nobody. */
async function execOnServer(command: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, output: `${stdout}${stderr}` };
}

export interface RunOutcome {
  run: JobRun;
  ok: boolean;
}

/** Runs one job now, whatever its schedule says. */
export async function runJob(jobId: string, trigger: 'schedule' | 'manual'): Promise<RunOutcome> {
  const job = findJob(jobId);
  if (!job) throw new Error('That job no longer exists.');

  const runId = newId();
  const startedAt = Date.now();
  db()
    .query('INSERT INTO job_runs (id, job_id, started_at, trigger) VALUES (?, ?, ?, ?)')
    .run(runId, jobId, startedAt, trigger);

  let exitCode = 1;
  let output = '';

  try {
    if (job.serviceId) {
      const containers = await listContainers(labelFilter({ [LABELS.service]: job.serviceId }));
      const running = containers.find((container) => container.State === 'running');
      if (!running) {
        output = 'The app is not running, so there was nothing to run this inside.';
      } else {
        ({ exitCode, output } = await execInContainer(running.Id, job.command));
      }
    } else {
      ({ exitCode, output } = await execOnServer(job.command));
    }
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = Date.now();
  db()
    .query('UPDATE job_runs SET finished_at = ?, exit_code = ?, output = ? WHERE id = ?')
    // Truncated: a job that prints a hundred megabytes should not put a hundred
    // megabytes in the database once an hour for ever.
    .run(finishedAt, exitCode, output.slice(-16_000), runId);

  db()
    .query('UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(finishedAt, nextRun(job.schedule), jobId);

  // Older runs go, so this cannot grow without bound.
  db()
    .query(
      `DELETE FROM job_runs WHERE job_id = ? AND id NOT IN
         (SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?)`,
    )
    .run(jobId, jobId, KEEP_RUNS);

  const ok = exitCode === 0;
  if (!ok && trigger === 'schedule') {
    const where = job.serviceId ? (findService(job.serviceId)?.name ?? 'an app') : 'this server';
    void raise({
      kind: 'job.failed',
      subject: `job:${jobId}`,
      detail: String(exitCode),
      severity: 'warning',
      title: `The scheduled job "${job.name}" failed`,
      body: `It exited with code ${exitCode} on ${where}.`,
      action: 'Its last run, and what it printed, are on the Jobs tab.',
    }).catch(() => undefined);
  }

  return { run: listRuns(jobId, 1)[0]!, ok };
}

/** Everything that is due. */
function dueJobs(now: number): Job[] {
  return db()
    .query<JobRow, [number]>(
      'SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    )
    .all(now)
    .map(toJob);
}

let running = false;

async function tick(): Promise<void> {
  // One at a time. Two overlapping sweeps on a small server is how a job that takes
  // longer than its own interval turns into a queue that never empties.
  if (running) return;
  running = true;
  try {
    for (const job of dueJobs(Date.now())) {
      await runJob(job.id, 'schedule').catch(() => undefined);
    }
  } finally {
    running = false;
  }
}

/** Checked every half minute, which is as precise as a minute-resolution cron needs. */
const TICK_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startJobs(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
}

export function stopJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
