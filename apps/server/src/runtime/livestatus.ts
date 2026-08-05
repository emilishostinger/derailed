import type { ServiceStatus } from '@derailed/shared';

/**
 * Last-known container status per service, as observed from Docker.
 *
 * Apps derive their status from their deployment history, which is the honest source
 * for them. Databases have no deployments at all. They are simply a container that
 * is either up or not. So without this they would sit on "Setting up" forever, no
 * matter how healthy the container was. That is exactly what happened on the first
 * real deployment.
 *
 * Kept deliberately in memory: it is a cache of something Docker already knows, and
 * it is repopulated within seconds of boot by `reconcile()` and the stats sampler.
 */
const known = new Map<string, ServiceStatus>();

export function recordLiveStatus(serviceId: string, status: ServiceStatus): void {
  known.set(serviceId, status);
}

export function liveStatus(serviceId: string): ServiceStatus | null {
  return known.get(serviceId) ?? null;
}

export function forgetLiveStatus(serviceId: string): void {
  known.delete(serviceId);
}

/**
 * Replaces everything we think we know with what Docker actually reports. Anything
 * not in `runningServiceIds` is, by definition, not running.
 */
export function reconcileLiveStatus(runningServiceIds: Iterable<string>): void {
  const running = new Set(runningServiceIds);
  for (const serviceId of known.keys()) {
    if (!running.has(serviceId)) known.set(serviceId, 'stopped');
  }
  for (const serviceId of running) known.set(serviceId, 'running');
}
