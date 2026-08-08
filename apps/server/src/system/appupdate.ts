import type { AppUpdate, AppUpdateAvailability, Service } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { createBackup } from '../backup/backup.ts';
import { FriendlyError } from '../build/git.ts';
import { queueDeployment } from '../build/pipeline.ts';
import {
  createAppUpdate,
  findAppUpdate,
  latestRevertibleUpdate,
  listAppUpdates,
  updateAppUpdate,
} from '../db/repo/appupdates.ts';
import { findDeployment } from '../db/repo/deployments.ts';
import { findService, listServices, updateService } from '../db/repo/services.ts';
import { dockerJson } from '../docker/client.ts';
import { inspectContainer, listContainers } from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { publishAll } from '../events/bus.ts';

/**
 * Updates that take a backup first.
 *
 * The pattern every trusted platform converged on: snapshot, update, verify, and
 * offer the way back. Three promises, kept in order:
 *
 * 1. **A copy first.** The whole project is backed up before anything is pulled,
 *    using the same archive a person can restore by hand. If the copy cannot be
 *    taken, the update does not start; that is the entire point of the order.
 * 2. **Checked before it takes over.** The new version deploys through the ordinary
 *    pipeline, which starts it beside the old one and only routes traffic once it
 *    answers. A version that never answers is thrown away and the old one keeps
 *    serving, without being asked.
 * 3. **The way back, written down.** The image that was running is recorded by
 *    digest, not by tag. The tag now means the new version, so the tag is exactly
 *    the wrong thing to remember. One press re-runs the old digest.
 *
 * Backup-before-update is deliberately not a setting. The only toggle is whether
 * updates happen without being asked.
 */

/** One update at a time per app. A second press while one runs would race the first. */
const inFlight = new Set<string>();

function emitUpdate(update: AppUpdate): void {
  const service = findService(update.serviceId);
  const relevant = [topics.service(update.serviceId)];
  if (service) relevant.push(topics.project(service.projectId));
  publishAll(relevant, { type: 'service.appupdate', update });
}

function shortDigest(ref: string | null): string | null {
  const digest = ref?.split('@')[1];
  return digest ? digest.slice(7, 19) : null;
}

/**
 * The image behind this app, pinned: `name@sha256:…` rather than a tag.
 *
 * Read from the local image the tag points at right now. Null when the image was
 * built locally or loaded by hand, in which case there is no registry copy to pin
 * and nothing to compare against.
 */
export async function pinnedImageRef(image: string): Promise<string | null> {
  try {
    const local = await dockerJson<{ RepoDigests?: string[] }>(
      `/images/${encodeURIComponent(image)}/json`,
    );
    const repo = image.split('@')[0]!.split(':')[0];
    const match = (local.RepoDigests ?? []).find((entry) => entry.startsWith(`${repo}@`));
    return match ?? local.RepoDigests?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The exact image this app is *running*, which is the honest way back.
 *
 * Read from the live container rather than from the configured tag: the two agree
 * on a quiet day, and disagree exactly when it matters, e.g. when the image field
 * was just changed to something new. Recording the new tag's digest as "the way
 * back" would make the revert button a second copy of the update button.
 */
export async function runningImageRef(service: Service): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  const running = containers.find((container) => container.State === 'running');
  if (running) {
    const inspected = await inspectContainer(running.Id).catch(() => null);
    const created = (inspected as { Config?: { Image?: string } } | null)?.Config?.Image;
    if (created?.includes('@')) return created;
    if (created) {
      const pinned = await pinnedImageRef(created);
      if (pinned) return pinned;
    }
  }
  return service.image ? pinnedImageRef(service.image) : null;
}

/** Whether the registry has published something newer under this app's tag. */
export async function checkAvailability(service: Service): Promise<AppUpdateAvailability> {
  const checkedAt = Date.now();
  if (service.source !== 'image' || !service.image) {
    return { current: null, available: null, checkedAt };
  }
  const currentRef = await pinnedImageRef(service.image);
  try {
    const remote = await dockerJson<{ Descriptor?: { digest?: string } }>(
      `/distribution/${encodeURIComponent(service.image)}/json`,
    );
    const remoteDigest = remote.Descriptor?.digest ?? null;
    const currentDigest = currentRef?.split('@')[1] ?? null;
    return {
      current: currentDigest ? currentDigest.slice(7, 19) : null,
      available: remoteDigest && remoteDigest !== currentDigest ? remoteDigest.slice(7, 19) : null,
      checkedAt,
    };
  } catch {
    // Private registry, rate limit, or no network. Not knowing is not an update.
    return { current: shortDigest(currentRef), available: null, checkedAt };
  }
}

/**
 * Waits for a deployment to reach a resting state. The pipeline runs in this same
 * process, so polling the row is cheap and needs no plumbing into the queue.
 */
async function deploymentOutcome(
  deploymentId: string,
  timeoutMs = 20 * 60_000,
): Promise<'running' | 'failed' | 'canceled' | 'superseded' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (!deployment) return 'canceled';
    if (
      deployment.status === 'running' ||
      deployment.status === 'failed' ||
      deployment.status === 'canceled' ||
      deployment.status === 'superseded'
    ) {
      return deployment.status;
    }
    await Bun.sleep(500);
  }
  return 'timeout';
}

/**
 * Starts one backup-first update.
 *
 * The row comes back the moment it exists, so the HTTP route can answer without
 * holding the connection open for a backup that may take minutes. `done` settles
 * when the whole flow has, which is what the tests and the auto-update sweep await.
 */
export async function beginAppUpdate(
  serviceId: string,
  trigger: 'manual' | 'auto' = 'manual',
): Promise<{ update: AppUpdate; done: Promise<AppUpdate> }> {
  const service = findService(serviceId);
  if (service?.kind !== 'app') {
    throw new FriendlyError('That app no longer exists.');
  }
  if (service.source !== 'image' || !service.image) {
    throw new FriendlyError(
      'This app is deployed from its repository, so updating it is deploying it.',
      'Press Deploy instead; every deploy already keeps the previous version to go back to.',
    );
  }
  if (inFlight.has(serviceId)) {
    throw new FriendlyError('This app is already being updated.');
  }
  inFlight.add(serviceId);

  const fromRef = await runningImageRef(service);
  const update = createAppUpdate(serviceId, trigger, fromRef);
  emitUpdate(update);

  const done = carryOutUpdate(update.id, service, fromRef, trigger).finally(() =>
    inFlight.delete(serviceId),
  );
  return { update, done };
}

/** The whole flow, awaited. For the sweep and the tests. */
export async function runAppUpdate(
  serviceId: string,
  trigger: 'manual' | 'auto' = 'manual',
): Promise<AppUpdate> {
  const { done } = await beginAppUpdate(serviceId, trigger);
  return done;
}

async function carryOutUpdate(
  updateId: string,
  service: Service,
  fromRef: string | null,
  trigger: 'manual' | 'auto',
): Promise<AppUpdate> {
  let update = findAppUpdate(updateId)!;
  // 1. The copy, before anything is touched.
  let backupWarnings: string[] = [];
  try {
    const backup = await createBackup(service.projectId);
    backupWarnings = backup.warnings ?? [];
    update = updateAppUpdate(update.id, { backupId: backup.id })!;
  } catch (err) {
    const summary = err instanceof FriendlyError ? err.message : 'The backup could not be taken.';
    update = updateAppUpdate(update.id, {
      status: 'failed',
      message: `${summary} Nothing was updated: the copy comes first.`,
      finishedAt: Date.now(),
    })!;
    emitUpdate(update);
    return update;
  }

  // 2. The new version, fetched and started beside the old one.
  update = updateAppUpdate(update.id, { status: 'deploying' })!;
  emitUpdate(update);

  try {
    await pullImage(service.image!);
  } catch (err) {
    update = updateAppUpdate(update.id, {
      status: 'failed',
      message: `The new image could not be fetched: ${
        err instanceof Error ? err.message : String(err)
      }. The app was not touched.`,
      finishedAt: Date.now(),
    })!;
    emitUpdate(update);
    return update;
  }

  const toRef = await pinnedImageRef(service.image!);
  if (toRef && fromRef && toRef === fromRef) {
    update = updateAppUpdate(update.id, {
      status: 'ok',
      toRef,
      message: 'Already on the newest version. The backup was kept anyway.',
      finishedAt: Date.now(),
    })!;
    emitUpdate(update);
    return update;
  }
  update = updateAppUpdate(update.id, { toRef })!;

  // Deploy the digest, not the tag: the deployment row then names the exact
  // version it ran, which is what makes rolling back to it honest later.
  const deployment = queueDeployment(
    service.id,
    trigger === 'auto' ? 'auto-update' : 'update',
    toRef ?? undefined,
  );
  const outcome = await deploymentOutcome(deployment.id);

  // 3. The verdict, in a sentence.
  if (outcome === 'running') {
    const kept = backupWarnings.length > 0 ? ` The backup noted: ${backupWarnings.join(' ')}` : '';
    update = updateAppUpdate(update.id, {
      status: 'ok',
      message: `Updated and answering.${kept}`,
      finishedAt: Date.now(),
    })!;
  } else if (outcome === 'failed') {
    const failed = findDeployment(deployment.id);
    update = updateAppUpdate(update.id, {
      status: 'failed',
      message: `${
        failed?.errorSummary ?? 'The new version did not answer.'
      } The previous version was never stopped and is still serving.`,
      finishedAt: Date.now(),
    })!;
  } else {
    update = updateAppUpdate(update.id, {
      status: 'failed',
      message:
        outcome === 'timeout'
          ? 'The update is taking too long to confirm. Check the deploy log.'
          : 'A newer deploy replaced this update before it finished.',
      finishedAt: Date.now(),
    })!;
  }
  emitUpdate(update);
  return update;
}

/**
 * Puts the version before the last update back: the recorded digest, re-run through
 * the same pipeline, health check and all. Data is not rolled back; the backup taken
 * before the update is on the Backups page for that.
 */
export async function revertAppUpdate(serviceId: string): Promise<AppUpdate> {
  const service = findService(serviceId);
  if (!service) throw new FriendlyError('That app no longer exists.');

  const last = latestRevertibleUpdate(serviceId);
  if (!last?.fromRef) {
    throw new FriendlyError(
      'There is no recorded version to go back to.',
      'The deploy history on the app can still roll back individual deploys.',
    );
  }

  // The old digest may have been pruned locally; the registry still has it, and a
  // digest is the one name that cannot have quietly come to mean something newer.
  if (!(await imageExists(last.fromRef))) {
    try {
      await pullImage(last.fromRef);
    } catch {
      throw new FriendlyError(
        'The previous version is no longer on this server or in the registry.',
        'Restore the backup taken before the update instead; it is on the Backups page.',
      );
    }
  }

  const deployment = queueDeployment(serviceId, 'rollback', last.fromRef);
  const outcome = await deploymentOutcome(deployment.id);
  const reverted = updateAppUpdate(last.id, {
    status: outcome === 'running' ? 'reverted' : last.status,
    message:
      outcome === 'running'
        ? 'Put back the way it was.'
        : 'Going back did not finish cleanly. Check the deploy log.',
    finishedAt: Date.now(),
  })!;
  emitUpdate(reverted);
  return reverted;
}

/** Everything the app screen needs in one answer. */
export async function appUpdateState(serviceId: string): Promise<{
  availability: AppUpdateAvailability;
  autoUpdate: boolean;
  history: AppUpdate[];
  canRevert: boolean;
}> {
  const service = findService(serviceId);
  if (!service) throw new FriendlyError('That app no longer exists.');
  return {
    availability: await checkAvailability(service),
    autoUpdate: !!service.autoUpdate,
    history: listAppUpdates(serviceId),
    canRevert: !!latestRevertibleUpdate(serviceId)?.fromRef,
  };
}

export function setAutoUpdate(serviceId: string, enabled: boolean): Service {
  const service = findService(serviceId);
  if (service?.kind !== 'app') throw new FriendlyError('That app no longer exists.');
  if (enabled && service.source !== 'image') {
    throw new FriendlyError(
      'Automatic updates are for apps run from a ready-made image.',
      'Apps deployed from a repository update when you deploy, or with deploy-on-push.',
    );
  }
  return updateService(serviceId, { autoUpdate: enabled })!;
}

/**
 * The daily look for apps that asked to look after themselves.
 *
 * One at a time rather than in parallel: each update takes a whole-project backup,
 * and a small server asked for five backups at once is a small server out of disk.
 */
export async function sweepAutoUpdates(): Promise<void> {
  for (const service of listServices()) {
    if (service.kind !== 'app' || !service.autoUpdate) continue;
    if (service.source !== 'image' || !service.image) continue;
    try {
      const availability = await checkAvailability(service);
      if (!availability.available) continue;
      await runAppUpdate(service.id, 'auto');
    } catch {
      // The row records how each update went; a sweep that dies on the first
      // problem would leave every app after it waiting for tomorrow.
    }
  }
}

const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startAppUpdates(): void {
  if (timer) return;
  timer = setInterval(() => void sweepAutoUpdates(), SWEEP_EVERY_MS);
  timer.unref?.();
}

export function stopAppUpdates(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { findAppUpdate };
