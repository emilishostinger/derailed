import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, queueDeployment, stopAllDeployments } from '../src/build/pipeline.ts';
import { uploadDir } from '../src/build/upload.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { findDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, inspectContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { removeNetwork } from '../src/docker/networks.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Edit a file, and it's live, proven whole: a dragged-in site is deployed, a 404
 * page is written the way the editor writes one, the site is deployed again, and a
 * request for a page that does not exist comes back as the custom page with a real
 * 404 status. This is the promise of the feature in one test, and it would not
 * have shown up in unit tests: the wiring lives in an nginx config inside a
 * container.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping site editor integration tests');
}

let dir = '';
let projectId = '';
let serviceId = '';

async function settle(deploymentId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (deployment?.finishedAt) return deployment;
    await Bun.sleep(500);
  }
  throw new Error('deployment never finished');
}

async function servedAt(path: string): Promise<{ status: number; body: string } | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  const running = containers.find((container) => container.State === 'running');
  if (!running) return null;
  const inspected = await inspectContainer(running.Id);
  const hostPort = Number(inspected?.NetworkSettings.Ports?.['80/tcp']?.[0]?.HostPort ?? 0);
  if (!hostPort) return null;
  const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.text() };
}

suite('the edited site, actually served', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-siteedit-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');

    projectId = createProject('Edited site').id;
    serviceId = createAppService({
      projectId,
      name: 'brochure',
      source: 'upload',
      repoUrl: null,
      branch: null,
    }).id;

    const files = uploadDir(serviceId);
    mkdirSync(files, { recursive: true });
    await Bun.write(join(files, 'index.html'), '<h1>Welcome to the brochure</h1>\n');
  }, 120_000);

  afterAll(async () => {
    await stopAllDeployments();
    expect(activeJobCount()).toBe(0);
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers) {
      await destroyContainer(container.Id, 2).catch(() => undefined);
    }
    await removeNetwork(projectId).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  test('a missing page is a plain nginx 404 before, and the custom page after', async () => {
    const first = await settle(queueDeployment(serviceId, 'manual').id);
    expect(first.status).toBe('running');

    const before = await servedAt('/no-such-page');
    expect(before?.status).toBe(404);
    expect(before?.body ?? '').not.toContain('or it has moved');

    // The editor's save: write the 404 page, redeploy, same as the route does.
    const { defaultErrorPage, writeSourceFile } = await import('../src/build/source.ts');
    await writeSourceFile(serviceId, '404.html', defaultErrorPage('404'));

    const second = await settle(queueDeployment(serviceId, 'manual').id);
    expect(second.status).toBe('running');

    const after = await servedAt('/no-such-page');
    expect(after?.status).toBe(404);
    expect(after?.body ?? '').toContain('or it has moved');
    // And the front page still serves.
    const home = await servedAt('/');
    expect(home?.status).toBe(200);
    expect(home?.body ?? '').toContain('Welcome to the brochure');
  }, 600_000);
});
