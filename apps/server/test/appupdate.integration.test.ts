import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, queueDeployment, stopAllDeployments } from '../src/build/pipeline.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { listAppUpdates } from '../src/db/repo/appupdates.ts';
import { findDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService, updateService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, inspectContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import {
  revertAppUpdate,
  runAppUpdate,
  setAutoUpdate,
  sweepAutoUpdates,
} from '../src/system/appupdate.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The full walk-through of the three promises, against real containers:
 *
 * 1. a copy is taken before anything is pulled;
 * 2. a new version that never answers is thrown away while the old one keeps
 *    serving, without being asked;
 * 3. one press re-runs the exact digest that was running before.
 *
 * nginx plays the app that answers; bare alpine plays the update that does not
 * (its shell exits immediately, so the health check can never pass).
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping app update integration tests');
}

const GOOD_IMAGE = 'nginx:alpine';
const BAD_IMAGE = 'alpine:3.20';

let dir = '';
let projectId = '';
let serviceId = '';

async function runningContainer() {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running') ?? null;
}

/** What the app actually answers with, through its loopback-published port. */
async function servedStatus(): Promise<number | null> {
  const container = await runningContainer();
  if (!container) return null;
  const inspected = await inspectContainer(container.Id);
  const hostPort = Number(inspected?.NetworkSettings.Ports?.['80/tcp']?.[0]?.HostPort ?? 0);
  if (!hostPort) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.status;
  } catch {
    return null;
  }
}

async function settle(deploymentId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (deployment?.finishedAt) return deployment;
    await Bun.sleep(500);
  }
  throw new Error('deployment never finished');
}

suite('backup-first updates against real containers', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-appupdate-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');

    const project = createProject('Update walkthrough');
    projectId = project.id;
    const service = createAppService({
      projectId,
      name: 'site',
      source: 'image',
      image: GOOD_IMAGE,
      repoUrl: null,
      branch: null,
      port: 80,
    });
    serviceId = service.id;

    const first = await settle(queueDeployment(serviceId, 'manual').id);
    expect(first.status).toBe('running');
  }, 600_000);

  afterAll(async () => {
    await stopAllDeployments();
    expect(activeJobCount()).toBe(0);
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 1).catch(() => undefined);
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  test('an update takes the copy, checks the answer, and records both versions', async () => {
    const update = await runAppUpdate(serviceId);

    expect(update.status).toBe('ok');
    expect(update.backupId).not.toBeNull();
    // The copy is a real file, findable on the Backups page.
    const { listBackups } = await import('../src/backup/backup.ts');
    const backups = await listBackups();
    expect(backups.map((backup) => backup.id)).toContain(update.backupId!);

    // Whatever the registry said, the app is still answering.
    expect(await servedStatus()).toBe(200);
  }, 600_000);

  test('a new version that never answers is discarded while the old one keeps serving', async () => {
    // Point the app at an image whose container exits immediately. The pull works;
    // the health check cannot.
    updateService(serviceId, { image: BAD_IMAGE });
    const update = await runAppUpdate(serviceId);

    expect(update.status).toBe('failed');
    expect(update.message).toContain('still serving');
    expect(update.backupId).not.toBeNull();

    // The promise itself: the old version never stopped.
    expect(await servedStatus()).toBe(200);
  }, 600_000);

  test('one press puts the recorded digest back', async () => {
    const reverted = await revertAppUpdate(serviceId);
    expect(reverted.status).toBe('reverted');
    expect(reverted.message).toContain('Put back');

    expect(await servedStatus()).toBe(200);
    // And what is running really is the digest that was recorded, not the tag.
    const container = await runningContainer();
    const inspected = await inspectContainer(container!.Id);
    expect((inspected as { Config?: { Image?: string } } | null)?.Config?.Image).toBe(
      reverted.fromRef!,
    );
  }, 600_000);

  test('the automatic sweep leaves an up-to-date app alone', async () => {
    updateService(serviceId, { image: GOOD_IMAGE });
    setAutoUpdate(serviceId, true);
    const before = listAppUpdates(serviceId).length;
    await sweepAutoUpdates();
    // nginx:alpine was pulled minutes ago; nothing newer exists, so nothing ran.
    expect(listAppUpdates(serviceId).length).toBe(before);
    expect(findService(serviceId)?.autoUpdate).toBe(true);
  }, 120_000);
});
