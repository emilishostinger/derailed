import { trafficFor } from '../analytics/store.ts';
import { db } from '../db/index.ts';
import { listServices } from '../db/repo/services.ts';
import { listContainers, startContainer, stopContainer } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { markIntentionalStop } from './intent.ts';

/**
 * Apps that pause when nobody is looking.
 *
 * On a $5 server this is the difference between running twelve side projects and
 * running four. Most of them are visited once a week, and an idle Rails app still
 * holds three hundred megabytes while it waits.
 *
 * Deliberately simple: pause after a stretch of quiet, and start again when somebody
 * asks for it. No prediction, no scheduling, nothing clever. The cost is that the
 * first visitor after a quiet spell waits a few seconds, which is exactly the trade
 * anybody switching this on is choosing to make.
 */

/** Below this, waking is slower than the sleep was worth. */
export const MIN_MINUTES = 5;

export function sleepSettingFor(serviceId: string): number | null {
  const row = db()
    .query<{ sleep_after_minutes: number | null }, [string]>(
      'SELECT sleep_after_minutes FROM services WHERE id = ?',
    )
    .get(serviceId);
  return row?.sleep_after_minutes ?? null;
}

export function setSleepAfter(serviceId: string, minutes: number | null): void {
  db()
    .query('UPDATE services SET sleep_after_minutes = ? WHERE id = ?')
    .run(minutes && minutes >= MIN_MINUTES ? minutes : null, serviceId);
}

/** Noted by the proxy's own traffic figures, which already count every request. */
export function markSeen(serviceId: string, at = Date.now()): void {
  db().query('UPDATE services SET last_seen_at = ? WHERE id = ?').run(at, serviceId);
}

export function lastSeen(serviceId: string): number | null {
  const row = db()
    .query<{ last_seen_at: number | null }, [string]>(
      'SELECT last_seen_at FROM services WHERE id = ?',
    )
    .get(serviceId);
  return row?.last_seen_at ?? null;
}

/**
 * Whether this app has been quiet long enough to pause.
 *
 * An app that has never been visited is left alone rather than paused immediately:
 * something deployed five minutes ago with no traffic yet is new, not idle, and
 * pausing it would be the worst possible first impression.
 */
export function shouldSleep(serviceId: string, now = Date.now()): boolean {
  const minutes = sleepSettingFor(serviceId);
  if (!minutes) return false;

  const seen = lastSeen(serviceId);
  if (seen === null) return false;

  return now - seen > minutes * 60 * 1000;
}

async function containersFor(serviceId: string) {
  return listContainers(labelFilter({ [LABELS.service]: serviceId }), true).catch(() => []);
}

/** Paused rather than stopped: the container keeps its place, so waking is instant. */
export async function sleepNow(serviceId: string): Promise<boolean> {
  const running = (await containersFor(serviceId)).filter(
    (container) => container.State === 'running',
  );
  if (!running.length) return false;

  for (const container of running) {
    // Marked intentional, or the monitor reports a crash and the alerts go off
    // every time an app quietly goes to sleep, which would be the fastest way to
    // teach somebody to ignore both features.
    markIntentionalStop(container.Id);
    await stopContainer(container.Id, 10).catch(() => undefined);
  }
  return true;
}

/**
 * Starts it again, and waits for it to answer.
 *
 * Called when a request arrives for something asleep. The visitor is already waiting,
 * so this returns as soon as the container is up rather than reporting and leaving
 * them with an error page for the one request that woke it.
 */
export async function wakeNow(serviceId: string): Promise<boolean> {
  const stopped = (await containersFor(serviceId)).filter(
    (container) => container.State !== 'running',
  );
  if (!stopped.length) return false;

  for (const container of stopped) {
    await startContainer(container.Id).catch(() => undefined);
  }
  markSeen(serviceId);
  return true;
}

export async function isAsleep(serviceId: string): Promise<boolean> {
  const containers = await containersFor(serviceId);
  return containers.length > 0 && containers.every((container) => container.State !== 'running');
}

/**
 * Reads the traffic figures to work out what has been visited.
 *
 * The proxy already counts every request for its own visitor figures, so this needs
 * no new logging and no request-path work: it is a read of numbers already being
 * kept, once a minute.
 */
function noteRecentTraffic(): void {
  for (const service of listServices()) {
    if (service.kind !== 'app' || !sleepSettingFor(service.id)) continue;
    try {
      const traffic = trafficFor(service.id, '24h');
      const latest = traffic.points?.[traffic.points.length - 1];
      if (latest && latest.requests > 0) markSeen(service.id, latest.at);
    } catch {
      // No figures yet. Nothing to note.
    }
  }
}

async function sweep(): Promise<void> {
  noteRecentTraffic();

  for (const service of listServices()) {
    if (service.kind !== 'app' || service.instancesDesired !== 1) continue;
    if (!shouldSleep(service.id)) continue;
    await sleepNow(service.id).catch(() => undefined);
  }
}

const INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startSleeper(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref?.();
}

export function stopSleeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
