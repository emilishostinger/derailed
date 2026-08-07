import type { LogLine } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { listServices } from '../db/repo/services.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { streamContainerLogs } from '../docker/logs.ts';
import { publish } from '../events/bus.ts';

/**
 * What an app is printing, right now.
 *
 * This is the thing people mean by "the logs", and it was the one kind this product
 * did not show. Build output was there, buried a tab deep in the deploy history, and
 * the actual output of the running program was reachable only by `derailed logs` on
 * the command line. Somebody whose site is misbehaving at eleven at night is not
 * opening a terminal; they are looking for a tab called Logs.
 *
 * Kept in memory rather than written anywhere. Docker already keeps these on disk and
 * rotates them, and a second copy would be a second thing to fill the disk and a
 * second thing to leak. This is a window onto what Docker has, not a store.
 */

/** Enough to see what happened, small enough that a hundred apps cannot eat the box. */
const KEPT_PER_SERVICE = 500;

interface Tail {
  lines: LogLine[];
  stop: AbortController;
  /** The container being followed, so a redeploy can be noticed. */
  containerId: string;
}

const tails = new Map<string, Tail>();

function remember(serviceId: string, line: LogLine): void {
  const tail = tails.get(serviceId);
  if (!tail) return;
  tail.lines.push(line);
  if (tail.lines.length > KEPT_PER_SERVICE) {
    tail.lines.splice(0, tail.lines.length - KEPT_PER_SERVICE);
  }
}

/** What this app has printed lately, oldest first. */
export function recentLogs(serviceId: string): LogLine[] {
  return tails.get(serviceId)?.lines ?? [];
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/**
 * Starts following one app, if it is not already being followed.
 *
 * Idempotent on purpose: it is called from a sweep, from the moment somebody opens the
 * Logs tab, and after every deploy, and none of those should have to know about the
 * others.
 */
async function follow(serviceId: string): Promise<void> {
  const containerId = await runningContainer(serviceId);
  if (!containerId) return;

  const existing = tails.get(serviceId);
  if (existing) {
    // Same container, already being read.
    if (existing.containerId === containerId) return;
    // A redeploy: the old container is gone, so stop reading it and start on the new
    // one. Without this, the Logs tab quietly goes silent after every deploy.
    existing.stop.abort();
    tails.delete(serviceId);
  }

  const stop = new AbortController();
  const tail: Tail = { lines: existing?.lines ?? [], stop, containerId };
  tails.set(serviceId, tail);

  void (async () => {
    try {
      for await (const entry of streamContainerLogs(containerId, {
        follow: true,
        tail: 200,
        signal: stop.signal,
      })) {
        const line: LogLine = {
          ts: Date.now(),
          stream: entry.stream,
          line: entry.line,
        };
        remember(serviceId, line);
        // Straight out to anybody watching this app. The batcher is for build logs,
        // which arrive in floods; a running program's output is usually a trickle and
        // is more useful immediately.
        publish(topics.service(serviceId), {
          type: 'service.logs',
          serviceId,
          lines: [line],
        });
      }
    } catch {
      // The container stopped, or Docker went away. The sweep will pick it up again
      // if it comes back.
    } finally {
      if (tails.get(serviceId)?.stop === stop) tails.delete(serviceId);
    }
  })();
}

export async function followService(serviceId: string): Promise<void> {
  await follow(serviceId).catch(() => undefined);
}

export function stopFollowing(serviceId: string): void {
  const tail = tails.get(serviceId);
  if (!tail) return;
  tail.stop.abort();
  tails.delete(serviceId);
}

/**
 * Keeps up with what is running.
 *
 * A sweep rather than hooks on every place a container can appear or vanish: there are
 * six of those and the seventh is the one somebody forgets. Every ten seconds is
 * frequent enough that the Logs tab is never blank for long, and cheap because it is
 * one call to Docker for the whole machine.
 */
async function sweep(): Promise<void> {
  const apps = listServices().filter((service) => service.kind === 'app');
  const wanted = new Set(apps.map((service) => service.id));

  for (const serviceId of tails.keys()) {
    if (!wanted.has(serviceId)) stopFollowing(serviceId);
  }
  for (const service of apps) await follow(service.id).catch(() => undefined);
}

const INTERVAL_MS = 10_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startLogTails(): void {
  if (timer) return;
  void sweep();
  timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref?.();
}

export function stopLogTails(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const serviceId of [...tails.keys()]) stopFollowing(serviceId);
}
