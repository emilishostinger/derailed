import { startDatabaseContainer } from '../catalog/create.ts';
import { allRunningDeployments, updateDeployment } from '../db/repo/deployments.ts';
import { listProjects } from '../db/repo/projects.ts';
import { containerName, findService, listServices } from '../db/repo/services.ts';
import { destroyContainer, listContainers, startContainer } from '../docker/containers.ts';
import { installId, LABELS } from '../docker/labels.ts';
import { ensureProjectNetwork } from '../docker/networks.ts';
import { attachCaddyToNetwork } from '../proxy/caddy.ts';
import { syncRoutes } from '../proxy/sync.ts';
import { reconcileLiveStatus } from './livestatus.ts';
import { emitService } from './present.ts';

export interface ReconcileReport {
  started: string[];
  removed: string[];
  markedStopped: string[];
  problems: string[];
}

/**
 * Brings the machine back in line with the database after a restart, of Derailed,
 * of Docker, or of the whole server. Only ever touches containers we labelled, so an
 * unrelated container on the same host is never affected.
 */
export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = { started: [], removed: [], markedStopped: [], problems: [] };

  let containers: Awaited<ReturnType<typeof listContainers>>;
  try {
    containers = await listContainers();
  } catch (err) {
    report.problems.push(err instanceof Error ? err.message : String(err));
    return report;
  }

  const byService = new Map<string, typeof containers>();
  for (const container of containers) {
    const serviceId = container.Labels?.[LABELS.service];
    if (!serviceId) continue;
    byService.set(serviceId, [...(byService.get(serviceId) ?? []), container]);
  }

  // Seed the live-status cache before anything is presented, so a database that is
  // already up doesn't read as "Setting up" for the first few seconds after a boot.
  reconcileLiveStatus(
    containers
      .filter((container) => container.State === 'running')
      .map((container) => container.Labels?.[LABELS.service])
      .filter(Boolean) as string[],
  );

  // 1. Containers whose service (or deployment) is gone from the database.
  for (const [serviceId, group] of byService) {
    const service = findService(serviceId);
    if (service) continue;
    for (const container of group) {
      // Made by a different installation on this machine: not ours to tidy away.
      // Containers from before this label existed have no id, and are still adopted.
      const owner = container.Labels?.[LABELS.install];
      if (owner && owner !== installId()) continue;
      await destroyContainer(container.Id, 5).catch(() => undefined);
      report.removed.push(container.Names?.[0] ?? container.Id.slice(0, 12));
    }
    byService.delete(serviceId);
  }

  // 2. Project networks exist and Caddy can reach them.
  for (const project of listProjects()) {
    try {
      const network = await ensureProjectNetwork(project.id);
      await attachCaddyToNetwork(network);
    } catch (err) {
      report.problems.push(
        `Couldn't set up networking for ${project.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 3. Services that should be running.
  for (const service of listServices()) {
    if (service.instancesDesired !== 1) continue;
    const group = byService.get(service.id) ?? [];

    if (service.kind === 'database') {
      try {
        await startDatabaseContainer(service.id);
        if (!group.some((container) => container.State === 'running')) {
          report.started.push(service.name);
        }
      } catch (err) {
        report.problems.push(
          `${service.name} didn't come back up: ${err instanceof Error ? err.message : err}`,
        );
      }
      continue;
    }

    const stale = group.filter((container) => container.State !== 'running');
    for (const container of stale) {
      try {
        await startContainer(container.Id);
        report.started.push(service.name);
      } catch {
        report.problems.push(`${service.name} wouldn't start again.`);
      }
    }
  }

  // 4. Deployments the database thinks are live but whose container has vanished.
  const expectedNames = new Set<string>();
  for (const deployment of allRunningDeployments()) {
    const service = findService(deployment.serviceId);
    if (!service) continue;
    const project = listProjects().find((entry) => entry.id === service.projectId);
    if (!project) continue;
    const name = containerName(project.slug, service.slug, deployment.id);
    expectedNames.add(name);

    const present = (byService.get(service.id) ?? []).some((container) =>
      container.Names?.some((candidate) => candidate.replace(/^\//, '') === name),
    );
    if (!present) {
      updateDeployment(deployment.id, {
        status: 'failed',
        errorSummary: `${service.name} is no longer running, its container disappeared while Derailed was off.`,
        errorHint: 'Deploy again to bring it back.',
        finishedAt: Date.now(),
      });
      report.markedStopped.push(service.name);
      emitService(service.id);
    }
  }

  await syncRoutes();
  return report;
}
