import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, stopAllDeployments } from '../src/build/pipeline.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { listDeployments } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { listServices } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, inspectContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { listVolumes, removeVolume } from '../src/docker/volumes.ts';
import { applyImportPlan } from '../src/import/apply.ts';
import { parseCompose } from '../src/import/compose.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * A compose repository, imported for real: one service built from the
 * repository, one ready-made image with storage and no web port, an alias with
 * an underscore in it, and depends_on turned into deploy order. The end state is
 * two running containers on one project network, one answering HTTP and the
 * other reachable by the exact name the file wrote.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping compose import integration tests');
}

let dir = '';
let repoDir = '';
let projectId = '';

const COMPOSE = [
  'services:',
  '  web_front:',
  '    build: ./site',
  '    ports:',
  '      - "8080:3000"',
  '    environment:',
  '      GREETING: hello from compose',
  '    depends_on:',
  '      - kv_store',
  '  kv_store:',
  '    image: redis:7.2-alpine',
  '    command: redis-server --appendonly yes',
  '    volumes:',
  '      - kv:/data',
  'volumes:',
  '  kv:',
].join('\n');

async function makeGitRepo(target: string): Promise<void> {
  await cp(join(import.meta.dir, 'fixtures/hello-dockerfile'), join(target, 'site'), {
    recursive: true,
  });
  await writeFile(join(target, 'docker-compose.yml'), COMPOSE);
  const run = async (args: string[]) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd: target,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Derailed Test',
        GIT_AUTHOR_EMAIL: 'test@derailed.local',
        GIT_COMMITTER_NAME: 'Derailed Test',
        GIT_COMMITTER_EMAIL: 'test@derailed.local',
      },
    });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  await run(['init', '-b', 'main']);
  await run(['add', '.']);
  await run(['commit', '-m', 'A little stack']);
}

async function settleAll(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unfinished = listServices(projectId).some((service) => {
      const [latest] = listDeployments(service.id, 1);
      return !latest?.finishedAt;
    });
    if (!unfinished) return;
    await Bun.sleep(500);
  }
  throw new Error('imported deployments never finished');
}

suite('a compose repository becomes a working project', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-compose-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    repoDir = join(dir, 'repo');
    await makeGitRepo(repoDir);
    projectId = createProject('Little stack').id;
  }, 120_000);

  afterAll(async () => {
    await stopAllDeployments();
    expect(activeJobCount()).toBe(0);
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 1).catch(() => undefined);
    const volumes = await listVolumes().catch(() => []);
    for (const volume of volumes) {
      if (volume.Labels?.[LABELS.project] === projectId) {
        await removeVolume(volume.Name).catch(() => undefined);
      }
    }
    // Built images are project-labelled too, via the deployments they came from.
    const { removeImage } = await import('../src/docker/images.ts');
    for (const service of listServices(projectId)) {
      for (const deployment of listDeployments(service.id, 10)) {
        if (deployment.imageTag?.startsWith('derailed/')) {
          await removeImage(deployment.imageTag).catch(() => undefined);
        }
      }
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  test('the file becomes services, deployed in dependency order, and both run', async () => {
    const reading = parseCompose(COMPOSE, { env: {} });
    const result = await applyImportPlan(projectId, {
      source: 'compose',
      repoUrl: repoDir,
      branch: 'main',
      services: reading.services,
      databases: [],
      jobs: [],
      warnings: reading.warnings,
    });
    expect(result.services.length).toBe(2);

    await settleAll();

    const services = listServices(projectId);
    const web = services.find((service) => service.name === 'web_front')!;
    const store = services.find((service) => service.name === 'kv_store')!;

    // Both deployments ended running, the store first.
    const [webDeploy] = listDeployments(web.id, 1);
    const [storeDeploy] = listDeployments(store.id, 1);
    expect(webDeploy!.status).toBe('running');
    expect(storeDeploy!.status).toBe('running');
    expect(storeDeploy!.createdAt).toBeLessThanOrEqual(webDeploy!.createdAt);

    // The built site answers over its loopback-published port.
    const containers = await listContainers(labelFilter({ [LABELS.service]: web.id }));
    const inspected = await inspectContainer(containers[0]!.Id);
    const hostPort = Number(inspected?.NetworkSettings.Ports?.['3000/tcp']?.[0]?.HostPort ?? 0);
    expect(hostPort).toBeGreaterThan(0);
    const answer = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(answer.status).toBe(200);
  }, 600_000);

  test('the store kept the name the file wrote, underscore and all', async () => {
    const services = listServices(projectId);
    const store = services.find((service) => service.name === 'kv_store')!;
    expect(store.healthCheck).toBe('started');
    expect(store.alias).toBe('kv_store');

    const containers = await listContainers(labelFilter({ [LABELS.service]: store.id }));
    expect(containers[0]!.State).toBe('running');
    const inspected = (await inspectContainer(containers[0]!.Id)) as {
      NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> };
    } | null;
    const aliases = Object.values(inspected?.NetworkSettings?.Networks ?? {}).flatMap(
      (network) => network.Aliases ?? [],
    );
    expect(aliases).toContain('kv_store');

    // And no generated web address points at something that can never answer one.
    const { listDomains } = await import('../src/db/repo/domains.ts');
    expect(listDomains(store.id).length).toBe(0);
  }, 120_000);

  test('the web app can actually reach it by that name', async () => {
    const services = listServices(projectId);
    const web = services.find((service) => service.name === 'web_front')!;
    const containers = await listContainers(labelFilter({ [LABELS.service]: web.id }));

    // From inside the web container, the compose-written hostname resolves.
    const proc = Bun.spawn(['docker', 'exec', containers[0]!.Id, 'nslookup', 'kv_store'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  }, 60_000);
});
