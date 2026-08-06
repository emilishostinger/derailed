import { deleteDeploymentLog } from '../build/deploylog.ts';
import { deleteDeployment, deploymentsToPrune, runningDeployment } from '../db/repo/deployments.ts';
import { listProjectsEvenIfDeleted } from '../db/repo/projects.ts';
import { listServices } from '../db/repo/services.ts';
import { removeImage } from '../docker/images.ts';
import {
  inspectNetwork,
  listNetworks,
  projectNetworkName,
  removeNetwork,
} from '../docker/networks.ts';
import { systemInfo } from '../system/status.ts';

/** How many deployments keep their logs and their image, per service. */
export const KEEP_DEPLOYMENTS = 10;

/**
 * A build needs room for a git checkout, a Docker build context and the resulting
 * image layers. Below this a build fails somewhere unhelpful, so it's better to say
 * so up front than to hand back a confusing Docker error.
 */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface PruneReport {
  deploymentsRemoved: number;
  logsRemoved: number;
  imagesRemoved: number;
}

/**
 * Deployment logs and images only ever grow in number. Keep the most recent few per
 * service and drop the rest, so a busy service can't quietly fill a small VPS.
 *
 * The running deployment is never pruned however old it is. Its image is the one
 * actually serving traffic, and its logs are the ones someone is most likely to want.
 */
export async function pruneOldDeployments(keep = KEEP_DEPLOYMENTS): Promise<PruneReport> {
  const report: PruneReport = { deploymentsRemoved: 0, logsRemoved: 0, imagesRemoved: 0 };

  for (const service of listServices()) {
    const running = runningDeployment(service.id);

    for (const deployment of deploymentsToPrune(service.id, keep)) {
      if (running && deployment.id === running.id) continue;

      await deleteDeploymentLog(deployment.id)
        .then(() => {
          report.logsRemoved++;
        })
        .catch(() => {
          // Already gone, which is the state we wanted anyway.
        });

      // Only images Derailed built are ours to delete. An image-sourced service runs
      // something public like `wordpress:php8.3-apache`, which may be shared with other
      // services and would only have to be pulled again.
      if (deployment.imageTag?.startsWith('derailed/')) {
        await removeImage(deployment.imageTag)
          .then(() => {
            report.imagesRemoved++;
          })
          .catch(() => {
            // Still referenced by a container, or already pruned. Not worth failing over.
          });
      }

      deleteDeployment(deployment.id);
      report.deploymentsRemoved++;
    }
  }

  return report;
}

/**
 * Removes project networks nothing is using any more.
 *
 * Every project gets its own bridge network, and Docker allocates each one a subnet
 * from a pool with a hard limit of about thirty. Left to accumulate, the failure is
 * not a leak that wastes a little memory: it is `all predefined address pools have
 * been fully subnetted`, at which point no project, no database and no deploy can
 * create a network again, on a machine that looks completely healthy.
 *
 * Only networks named after a project that no longer exists, and only when nothing is
 * attached. A network belonging to something in the trash is left alone: restoring a
 * project should find its apps able to reach their databases without a redeploy.
 */
export async function pruneOrphanedNetworks(): Promise<string[]> {
  const known = new Set(
    listProjectsEvenIfDeleted().map((project) => projectNetworkName(project.id)),
  );
  const removed: string[] = [];

  for (const network of await listNetworks().catch(() => [])) {
    if (!network.Name.startsWith('derailed-p_')) continue;
    if (known.has(network.Name)) continue;

    // Attached to something, whatever the database thinks. Removing it would cut a
    // running container off from whatever it is talking to.
    const details = await inspectNetwork(network.Name).catch(() => null);
    if (details && Object.keys(details.Containers ?? {}).length > 0) continue;

    await removeNetwork(network.Name).catch(() => undefined);
    removed.push(network.Name);
  }

  return removed;
}

export interface DiskCheck {
  ok: boolean;
  freeBytes: number;
  message?: string;
  hint?: string;
}

/** Checked before a build starts, and surfaced in the dashboard as a warning. */
export async function checkDiskSpace(min = MIN_FREE_BYTES): Promise<DiskCheck> {
  const info = await systemInfo();
  if (!info.disk) return { ok: true, freeBytes: 0 };

  const freeBytes = info.disk.freeBytes;
  if (freeBytes >= min) return { ok: true, freeBytes };

  // The hint used to be a `docker system prune -a` to run over SSH, which is both the
  // wrong altitude for this audience and more destructive than what the button does.
  return {
    ok: false,
    freeBytes,
    message: `This server has only ${formatBytes(freeBytes)} of disk space left, which isn't enough to build an app.`,
    hint: 'Open the Server page and press "Free up space". It shows what it will remove before it removes it.',
  };
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
