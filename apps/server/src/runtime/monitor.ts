import type { ServiceStatus } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { containerStats, listContainers } from '../docker/containers.ts';
import { type ContainerEvent, watchContainerEvents } from '../docker/events.ts';
import { LABELS } from '../docker/labels.ts';
import { publishAll } from '../events/bus.ts';
import { consumeIntentionalStop } from './intent.ts';
import { reconcileLiveStatus, recordLiveStatus } from './livestatus.ts';

const STATS_INTERVAL_MS = 5000;

type StatusHook = (event: ContainerEvent, status: ServiceStatus) => void;

let stopWatching: (() => void) | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
const hooks = new Set<StatusHook>();

/** Phase 2 hangs deployment bookkeeping off this; the monitor itself stays dumb. */
export function onContainerStatus(hook: StatusHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

export function statusFromEvent(event: ContainerEvent): ServiceStatus | null {
  switch (event.action) {
    case 'start':
    case 'restart':
    case 'unpause':
      return 'running';
    case 'die':
      // A container we stopped ourselves exits 143/137 (same codes as a crash) so
      // the only reliable signal is whether we asked for it.
      if (consumeIntentionalStop(event.containerId)) return 'stopped';
      return event.exitCode === 0 ? 'stopped' : 'crashed';
    case 'kill':
    case 'stop':
    case 'pause':
      return 'stopped';
    case 'oom':
      return 'crashed';
    default:
      return null;
  }
}

/**
 * Turns Docker's event stream into service status updates, and samples CPU/memory
 * for running containers. Both go straight onto the event bus. A browser watching
 * a project sees a crash within a couple of seconds, with no polling of our API.
 */
export function startMonitor(): void {
  if (stopWatching) return;

  stopWatching = watchContainerEvents((event) => {
    const status = statusFromEvent(event);
    if (!status || !event.serviceId) return;

    recordLiveStatus(event.serviceId, status);

    const relevant = [topics.service(event.serviceId)];
    if (event.projectId) relevant.push(topics.project(event.projectId));

    publishAll(relevant, { type: 'service.status', serviceId: event.serviceId, status });
    for (const hook of hooks) hook(event, status);
  });

  statsTimer = setInterval(() => {
    void sampleStats();
  }, STATS_INTERVAL_MS);
  statsTimer.unref?.();
}

export function stopMonitor(): void {
  stopWatching?.();
  stopWatching = null;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

async function sampleStats(): Promise<void> {
  let running: Awaited<ReturnType<typeof listContainers>>;
  try {
    running = (await listContainers()).filter((c) => c.State === 'running');
  } catch {
    return;
  }

  // Docker's event stream can be missed (a restart, a dropped connection), so treat
  // this five-second sweep as the authority on what is actually up.
  reconcileLiveStatus(
    running.map((container) => container.Labels?.[LABELS.service]).filter(Boolean) as string[],
  );

  await Promise.all(
    running.map(async (container) => {
      const serviceId = container.Labels?.[LABELS.service];
      if (!serviceId) return;
      const stats = await containerStats(container.Id);
      if (!stats) return;
      const projectId = container.Labels?.[LABELS.project];
      const relevant = [topics.service(serviceId)];
      if (projectId) relevant.push(topics.project(projectId));
      publishAll(relevant, {
        type: 'service.stats',
        serviceId,
        cpuPercent: stats.cpuPercent,
        memoryBytes: stats.memoryBytes,
        memoryLimitBytes: stats.memoryLimitBytes,
      });
    }),
  );
}
