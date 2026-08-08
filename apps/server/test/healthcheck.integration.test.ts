import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, queueDeployment, stopAllDeployments } from '../src/build/pipeline.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { findDeployment } from '../src/db/repo/deployments.ts';
import { listDomains } from '../src/db/repo/domains.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, updateService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { removeNetwork } from '../src/docker/networks.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The five kinds of health check, against real containers.
 *
 * Redis is the app that never speaks HTTP: the 'tcp' and 'command' checks are the
 * only honest ways to know it started, and before them it could only be held to
 * "keeps running". nginx is the app whose words matter: 'contains' has to pass when
 * the page says them and fail the deploy when it does not, because a 200 with the
 * wrong words is the failure a status code cannot see.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping health check integration tests');
}

let dir = '';
let projectId = '';

async function settle(deploymentId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (deployment?.finishedAt) return deployment;
    await Bun.sleep(500);
  }
  throw new Error('deployment never finished');
}

suite('health checks against real containers', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-health-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');
    projectId = createProject('Health kinds').id;
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

  test('a Redis proves itself by accepting a connection', async () => {
    const service = createAppService({
      projectId,
      name: 'cache-tcp',
      source: 'image',
      image: 'redis:7-alpine',
      repoUrl: null,
      branch: null,
      port: 6379,
      healthCheck: 'tcp',
    });
    const deployment = await settle(queueDeployment(service.id, 'manual').id);
    expect(deployment.status).toBe('running');
    // A web address for a thing that cannot speak HTTP could only ever serve an
    // error, so none is generated.
    expect(listDomains(service.id)).toEqual([]);
  }, 360_000);

  test('a Redis proves itself by answering PONG to its own client', async () => {
    const service = createAppService({
      projectId,
      name: 'cache-cmd',
      source: 'image',
      image: 'redis:7-alpine',
      repoUrl: null,
      branch: null,
      port: 6379,
      healthCheck: 'command',
    });
    // The create path has no command field; set it the way the API does.
    updateService(service.id, { healthCommand: 'redis-cli ping | grep -q PONG' });
    const deployment = await settle(queueDeployment(service.id, 'manual').id);
    expect(deployment.status).toBe('running');
  }, 360_000);

  test('a page that says the words passes, and one that does not fails the deploy', async () => {
    const saying = createAppService({
      projectId,
      name: 'site-says',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
      port: 80,
      healthCheck: 'contains',
    });
    updateService(saying.id, { healthExpect: 'nginx' });
    const good = await settle(queueDeployment(saying.id, 'manual').id);
    expect(good.status).toBe('running');

    const silent = createAppService({
      projectId,
      name: 'site-silent',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
      port: 80,
      healthCheck: 'contains',
    });
    updateService(silent.id, { healthExpect: 'the words this page will never say' });
    const bad = await settle(queueDeployment(silent.id, 'manual').id);
    expect(bad.status).toBe('failed');
    expect(bad.errorSummary ?? '').toContain('never said');
  }, 360_000);
});
