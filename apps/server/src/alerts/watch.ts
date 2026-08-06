import { findProject } from '../db/repo/projects.ts';
import { findService } from '../db/repo/services.ts';
import { onContainerStatus } from '../runtime/monitor.ts';
import { diskReport } from '../system/disk.ts';
import { serverStats } from '../system/stats.ts';
import { clearAlert, fingerprint, raise } from './notify.ts';

/**
 * Turning things that happen into things worth saying.
 *
 * Everything here already existed as an event on the bus or a number on a page. What
 * this adds is the judgement: a container exiting is not news, a container exiting
 * four times in five minutes is. And every message says what to do, because a
 * notification that made your phone buzz and left you no better off is worse than
 * silence.
 */

/** How many crashes, in how long, before it stops being bad luck. */
const LOOP_COUNT = 3;
const LOOP_WINDOW_MS = 5 * 60 * 1000;

const crashes = new Map<string, number[]>();

function recordCrash(serviceId: string, now: number): number {
  const recent = (crashes.get(serviceId) ?? []).filter((at) => now - at < LOOP_WINDOW_MS);
  recent.push(now);
  crashes.set(serviceId, recent);
  return recent.length;
}

function nameOf(serviceId: string): { app: string; project: string } | null {
  const service = findService(serviceId);
  if (!service) return null;
  return { app: service.name, project: findProject(service.projectId)?.name ?? 'a project' };
}

/**
 * Crashes and crash loops.
 *
 * The single crash is reported once and then stays quiet; the loop is reported
 * separately because it means something different and needs a different answer.
 */
function watchCrashes(): () => void {
  return onContainerStatus((event, status) => {
    if (!event.serviceId) return;

    if (status === 'running') {
      // Back up, so the next time it falls over is news again.
      clearAlert(fingerprint('app.crashed', event.serviceId));
      clearAlert(fingerprint('app.crashloop', event.serviceId));
      crashes.delete(event.serviceId);
      return;
    }

    if (status !== 'crashed') return;

    const named = nameOf(event.serviceId);
    if (!named) return;

    const count = recordCrash(event.serviceId, Date.now());
    const oom = event.action === 'oom';

    if (count >= LOOP_COUNT) {
      void raise({
        kind: 'app.crashloop',
        subject: event.serviceId,
        severity: 'critical',
        title: `${named.app} keeps crashing`,
        body: `It has stopped unexpectedly ${count} times in the last few minutes, so it is not staying up long enough to be useful. It is in ${named.project}.`,
        action: oom
          ? 'It is running out of memory. Give it a higher memory limit on its Settings tab, or add swap on the Server page.'
          : 'Open its Logs tab: the last thing it printed before each exit is what to look at.',
      });
      return;
    }

    void raise({
      kind: 'app.crashed',
      subject: event.serviceId,
      severity: 'warning',
      title: `${named.app} stopped unexpectedly`,
      body: oom
        ? `It ran out of memory and was killed. It is in ${named.project}.`
        : `It exited on its own, with code ${event.exitCode ?? 'unknown'}. It is in ${named.project}.`,
      action: oom
        ? 'Raise its memory limit, or add swap on the Server page.'
        : 'Its Logs tab has whatever it printed on the way out.',
    });
  });
}

/** Called by the deploy pipeline, which knows more about the failure than we do. */
export async function alertDeployFailed(
  serviceId: string,
  summary: string,
  hint?: string | null,
): Promise<void> {
  const named = nameOf(serviceId);
  if (!named) return;

  await raise({
    kind: 'deploy.failed',
    subject: serviceId,
    // Deliberately part of the fingerprint: the same app failing the same way twice
    // is one situation, but failing a *different* way is news again.
    detail: summary,
    severity: 'warning',
    title: `Deploying ${named.app} failed`,
    body: summary,
    action: hint ?? 'The deploy log has the details.',
  });
}

export async function alertDeploySucceeded(serviceId: string, commit?: string | null) {
  const named = nameOf(serviceId);
  if (!named) return;

  await raise({
    kind: 'deploy.succeeded',
    subject: serviceId,
    detail: commit ?? String(Date.now()),
    severity: 'info',
    title: `${named.app} is live`,
    body: commit ? `Deployed ${commit.slice(0, 7)}.` : 'A new version is running.',
  });
}

export async function alertBackupFailed(projectName: string, reason: string): Promise<void> {
  await raise({
    kind: 'backup.failed',
    subject: projectName,
    detail: reason,
    severity: 'warning',
    title: `Backing up ${projectName} failed`,
    body: reason,
    action: 'The Backups page has the rest, and a button to try again now.',
  });
}

export async function alertDrillFailed(problems: string[]): Promise<void> {
  await raise({
    kind: 'drill.failed',
    subject: 'drill',
    detail: problems.join('|'),
    severity: 'critical',
    title: 'A backup turned out not to restore',
    body: `Derailed opened the newest backup to check it and found: ${problems.join('; ')}.`,
    action: 'This is worth looking at now, while there is still time to make a good one.',
  });
}

/**
 * The slow-moving problems, checked on a timer rather than reacted to.
 *
 * Disk and memory do not fire events; they creep. Hourly is often enough that nobody
 * is surprised, and rare enough that the send-once rule does the rest.
 */
async function sweep(): Promise<void> {
  const disk = await diskReport().catch(() => null);
  if (disk) {
    if (disk.level === 'full') {
      await raise({
        kind: 'disk.low',
        subject: 'disk',
        severity: 'critical',
        title: 'This server is nearly out of disk space',
        body: disk.summary,
        action:
          disk.reclaimableBytes > 0
            ? 'The Server page has a button that frees up the space nothing is using.'
            : 'Delete something you no longer need, or move the backups off this machine.',
      });
    } else {
      clearAlert(fingerprint('disk.low', 'disk'));
    }
  }

  // Only Linux reports a memory figure worth acting on: see the doctor's own note.
  if (process.platform === 'linux') {
    const stats = await serverStats().catch(() => null);
    if (stats && stats.memory.percent >= 94) {
      await raise({
        kind: 'memory.low',
        subject: 'memory',
        severity: 'warning',
        title: 'This server is nearly out of memory',
        body: `${stats.memory.percent}% is in use. When it runs out, the system kills whichever app is using the most, which looks like an app restarting for no reason.`,
        action: 'Add swap on the Server page, or give the biggest app a memory limit.',
      });
    } else if (stats) {
      clearAlert(fingerprint('memory.low', 'memory'));
    }
  }
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let unwatch: (() => void) | null = null;

export function startAlerts(): void {
  if (unwatch) return;
  unwatch = watchCrashes();
  timer = setInterval(() => void sweep().catch(() => undefined), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopAlerts(): void {
  unwatch?.();
  unwatch = null;
  if (timer) clearInterval(timer);
  timer = null;
}
