import type { TrashItem } from '@derailed/shared';
import { deleteDeploymentLog } from '../build/deploylog.ts';
import { forgetReadme } from '../build/readme.ts';
import { removeUpload } from '../build/upload.ts';
import { listDeployments } from '../db/repo/deployments.ts';
import {
  deleteProject,
  findProjectEvenIfDeleted,
  listDeletedProjects,
  restoreProject,
} from '../db/repo/projects.ts';
import {
  deleteService,
  findServiceEvenIfDeleted,
  listDeletedServices,
  listServicesEvenIfDeleted,
  restoreService,
} from '../db/repo/services.ts';
import { listVolumesFor } from '../db/repo/volumes.ts';
import { destroyContainer, listContainers } from '../docker/containers.ts';
import { removeImage } from '../docker/images.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../docker/networks.ts';
import { removeVolume } from '../docker/volumes.ts';
import { forgetPreview } from './preview.ts';

/**
 * Deleting is not the end of it.
 *
 * Every other dangerous action here explains itself before you take it. Deleting an
 * app explained itself and then destroyed the folders holding its data, which is the
 * one thing on this server nobody can get back. A confirmation dialog is not much
 * help at two in the morning.
 *
 * So a delete now stops the containers, frees the addresses, and leaves everything
 * that holds data exactly where it is. A week later the trash is emptied and the
 * removal happens for real. In between, "put it back" works.
 */

/** How long something stays recoverable. */
export const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything currently recoverable, newest first. */
export function listTrash(): TrashItem[] {
  const items: TrashItem[] = [];

  for (const project of listDeletedProjects()) {
    const deletedAt = project.deletedAt ?? 0;
    items.push({
      kind: 'project',
      id: project.id,
      name: project.name,
      parentName: null,
      deletedAt,
      purgeAt: deletedAt + KEEP_FOR_MS,
      whatIsKept: keptForProject(project.id, deletedAt),
    });
  }

  for (const service of listDeletedServices()) {
    const deletedAt = service.deletedAt ?? 0;
    // A service that went down with its project is already listed as part of it.
    // Showing both would read as two separate things to restore, and restoring the
    // app on its own would put it back inside a project that is still deleted.
    const project = findProjectEvenIfDeleted(service.projectId);
    if (project?.deletedAt === deletedAt) continue;

    items.push({
      kind: 'service',
      id: service.id,
      name: service.name,
      parentName: project?.name ?? null,
      deletedAt,
      purgeAt: deletedAt + KEEP_FOR_MS,
      whatIsKept: keptForService(service.id),
    });
  }

  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** What is still on disk for one app, in words rather than counts of nothing. */
function keptForService(serviceId: string): string[] {
  const kept: string[] = [];
  const volumes = listVolumesFor(serviceId);
  if (volumes.length) {
    kept.push(
      volumes.length === 1 ? 'Its stored files' : `Its stored files, in ${volumes.length} places`,
    );
  }
  const service = findServiceEvenIfDeleted(serviceId);
  if (service?.kind === 'database') kept.push('The database itself, and everything in it');
  kept.push('Its settings and variables');
  return kept;
}

function keptForProject(projectId: string, deletedAt: number): string[] {
  const services = listServicesEvenIfDeleted(projectId).filter(
    (service) => service.deletedAt === deletedAt,
  );
  const apps = services.filter((service) => service.kind === 'app').length;
  const databases = services.filter((service) => service.kind === 'database').length;

  const kept: string[] = [];
  if (apps) kept.push(apps === 1 ? '1 app' : `${apps} apps`);
  if (databases) {
    kept.push(databases === 1 ? '1 database, with its data' : `${databases} databases, with data`);
  }
  const stored = services.reduce((sum, service) => sum + listVolumesFor(service.id).length, 0);
  if (stored) kept.push(stored === 1 ? '1 stored folder' : `${stored} stored folders`);
  return kept.length ? kept : ['Its settings'];
}

/** True if this is still recoverable rather than already swept. */
export function isRecoverable(item: { deletedAt?: number | null }, now = Date.now()): boolean {
  return (
    item.deletedAt !== null && item.deletedAt !== undefined && now - item.deletedAt < KEEP_FOR_MS
  );
}

export function restore(kind: 'project' | 'service', id: string): boolean {
  if (kind === 'project') {
    const project = findProjectEvenIfDeleted(id);
    if (!project?.deletedAt) return false;
    restoreProject(id);
    return true;
  }
  const service = findServiceEvenIfDeleted(id);
  if (!service?.deletedAt) return false;
  // An app cannot come back into a project that is still in the trash: it would be
  // invisible, unroutable, and impossible to find again.
  const project = findProjectEvenIfDeleted(service.projectId);
  if (project?.deletedAt) restoreProject(project.id);
  restoreService(id);
  return true;
}

/**
 * Removes one service's belongings from Docker and disk. The row is the caller's to
 * delete, because a project purge wants the rows gone in one go afterwards.
 */
async function purgeServiceBelongings(serviceId: string): Promise<void> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  for (const container of containers) {
    await destroyContainer(container.Id, 5).catch(() => undefined);
  }

  // A high limit rather than the default: leaving images behind because a service had
  // thirty-one deploys is how a disk fills up with nothing pointing at the cause.
  for (const deployment of listDeployments(serviceId, 1000)) {
    await deleteDeploymentLog(deployment.id);
    if (deployment.imageTag) await removeImage(deployment.imageTag).catch(() => undefined);
  }

  for (const volume of listVolumesFor(serviceId)) {
    await removeVolume(volume.name).catch(() => undefined);
  }

  await removeUpload(serviceId).catch(() => undefined);
  await forgetPreview(serviceId).catch(() => undefined);
  await forgetReadme(serviceId).catch(() => undefined);
}

/** Throws one item away for good. */
export async function purge(kind: 'project' | 'service', id: string): Promise<void> {
  if (kind === 'service') {
    await purgeServiceBelongings(id);
    deleteService(id);
    return;
  }

  const project = findProjectEvenIfDeleted(id);
  if (!project) return;
  for (const service of listServicesEvenIfDeleted(id)) {
    await purgeServiceBelongings(service.id);
  }
  deleteProject(id);
  await removeNetwork(projectNetworkName(id)).catch(() => undefined);
}

/**
 * Empties whatever is past its week. Called at boot and daily after that.
 *
 * Returns what it removed so the log can say, because a sweep that silently deletes
 * a database is exactly the kind of thing people want a record of.
 */
export async function emptyExpiredTrash(now = Date.now()): Promise<string[]> {
  const removed: string[] = [];

  for (const project of listDeletedProjects()) {
    if (now - (project.deletedAt ?? 0) < KEEP_FOR_MS) continue;
    await purge('project', project.id);
    removed.push(`project ${project.name}`);
  }

  for (const service of listDeletedServices()) {
    if (now - (service.deletedAt ?? 0) < KEEP_FOR_MS) continue;
    await purge('service', service.id);
    removed.push(`${service.kind} ${service.name}`);
  }

  return removed;
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startTrashSweep(onLog?: (line: string) => void): void {
  if (timer) return;
  const tick = async () => {
    const removed = await emptyExpiredTrash().catch(() => []);
    for (const what of removed) onLog?.(`emptied from trash: ${what}`);
  };
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopTrashSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
