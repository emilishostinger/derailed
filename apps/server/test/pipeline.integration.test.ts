/**
 * End-to-end deploy: a real git repository, a real image build, a real container,
 * a real health check. This is the walk-through of the product's core promise.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeploymentLog } from '../src/build/deploylog.ts';
import { queueDeployment } from '../src/build/pipeline.ts';
import { removeUpload, storeUpload } from '../src/build/upload.ts';
import { initDb } from '../src/db/index.ts';
import { findDeployment, listDeployments } from '../src/db/repo/deployments.ts';
import { listDomains } from '../src/db/repo/domains.ts';
import { setEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { containerName, createAppService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { ping } from '../src/docker/client.ts';
import {
  destroyContainer,
  findContainerByName,
  inspectContainer,
  listContainers,
} from '../src/docker/containers.ts';
import { removeImage } from '../src/docker/images.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { removeVolume } from '../src/docker/volumes.ts';
import { serviceStatus } from '../src/runtime/present.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 8);
let dir = '';
let repoDir = '';
let projectId = '';
let serviceId = '';
let projectSlug = '';
let serviceSlug = '';

async function makeGitRepo(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true });
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
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  await run(['init', '-b', 'main']);
  await run(['add', '.']);
  await run(['commit', '-m', 'Say hello']);
}

/** Waits for a deployment to reach a terminal state. */
async function settle(deploymentId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    // finishedAt is the signal: a deployment is "running" a moment before the old
    // container has been retired.
    if (deployment?.finishedAt) return deployment;
    await Bun.sleep(500);
  }
  throw new Error('deployment never finished');
}

suite('deploy pipeline', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-pipeline-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');

    repoDir = join(dir, 'repo');
    await makeGitRepo(join(import.meta.dir, 'fixtures/hello-dockerfile'), repoDir);

    const project = createProject(`Pipeline ${RUN_ID}`);
    projectId = project.id;
    projectSlug = project.slug;

    const service = createAppService({
      projectId,
      name: 'web',
      repoUrl: repoDir,
      branch: 'main',
    });
    serviceId = service.id;
    serviceSlug = service.slug;
  }, 120_000);

  afterAll(async () => {
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 1).catch(() => undefined);
    for (const deployment of listDeployments(serviceId, 100)) {
      if (deployment.imageTag) await removeImage(deployment.imageTag).catch(() => undefined);
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  test('clones, builds, starts and health-checks an app', async () => {
    setEnv(serviceId, 'GREETING', 'hello');
    const queued = queueDeployment(serviceId, 'manual');
    const deployment = await settle(queued.id);

    expect(deployment.status).toBe('running');
    expect(deployment.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(deployment.commitMessage).toBe('Say hello');
    expect(deployment.imageTag).toContain(serviceId);
  }, 300_000);

  test('the container is actually serving', async () => {
    const name = containerName(
      projectSlug,
      serviceSlug,
      findDeployment(listDeployments(serviceId)[0]!.id)!.id,
    );
    const container = await findContainerByName(name);
    expect(container?.State).toBe('running');

    const inspected = await inspectContainer(container!.Id);
    const hostPort = inspected?.NetworkSettings.Ports['3000/tcp']?.[0]?.HostPort;
    expect(hostPort).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('hello from derailed');
  }, 60_000);

  test('injects PORT and the user variables into the container', async () => {
    const container = (await listContainers(labelFilter({ [LABELS.service]: serviceId }))).find(
      (entry) => entry.State === 'running',
    );
    const inspected = await inspectContainer(container!.Id);
    expect(inspected?.Config.Env).toContain('PORT=3000');
    expect(inspected?.Config.Env).toContain('GREETING=hello');
  }, 60_000);

  test('writes a readable build log', async () => {
    const deployment = listDeployments(serviceId)[0]!;
    const lines = await readDeploymentLog(deployment.id, 500);
    const text = lines.map((line) => line.line).join('\n');

    expect(text).toContain('Getting the code');
    expect(text).toContain('own build instructions');
    expect(text).toContain('is live');
    expect(lines.some((line) => line.stream === 'build')).toBe(true);
  }, 30_000);

  test('gives the app a working web address', () => {
    const domains = listDomains(serviceId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.hostname).toBe(`${serviceSlug}.203-0-113-7.sslip.io`);
    expect(domains[0]!.kind).toBe('generated');
  });

  test('reports the service as running', () => {
    const service = { id: serviceId } as never;
    expect(
      serviceStatus({
        ...(service as object),
        id: serviceId,
        kind: 'app',
        instancesDesired: 1,
      } as never),
    ).toBe('running');
  });

  test('a redeploy supersedes the old one and leaves a single container', async () => {
    await writeFile(join(repoDir, 'CHANGED.md'), 'second version\n');
    const proc = Bun.spawn(['git', 'commit', '-am', 'Second version'], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Derailed Test',
        GIT_AUTHOR_EMAIL: 'test@derailed.local',
        GIT_COMMITTER_NAME: 'Derailed Test',
        GIT_COMMITTER_EMAIL: 'test@derailed.local',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;

    const previous = listDeployments(serviceId)[0]!;
    const queued = queueDeployment(serviceId, 'redeploy');
    const deployment = await settle(queued.id);

    expect(deployment.status).toBe('running');
    expect(findDeployment(previous.id)!.status).toBe('superseded');

    const running = (await listContainers(labelFilter({ [LABELS.service]: serviceId }))).filter(
      (entry) => entry.State === 'running',
    );
    expect(running).toHaveLength(1);
    expect(running[0]!.Labels[LABELS.deployment]).toBe(deployment.id);
  }, 300_000);

  test('storage stays attached across a redeploy, with the same volume', async () => {
    // The point of the whole feature: a new container every deploy means anything the
    // app wrote is gone unless it lives on a volume that outlives the container.
    const volume = createVolume(serviceId, '/keepme');

    const first = await settle(queueDeployment(serviceId, 'manual').id);
    expect(first.status).toBe('running');

    const mountedFirst = await inspectContainer(first.containerId!);
    const firstMounts =
      (mountedFirst as unknown as { Mounts?: { Name?: string; Destination?: string }[] }).Mounts ??
      [];
    expect(firstMounts.some((m) => m.Name === volume.name && m.Destination === '/keepme')).toBe(
      true,
    );

    const second = await settle(queueDeployment(serviceId, 'redeploy').id);
    expect(second.status).toBe('running');
    expect(second.containerId).not.toBe(first.containerId);

    const mountedSecond = await inspectContainer(second.containerId!);
    const secondMounts =
      (mountedSecond as unknown as { Mounts?: { Name?: string }[] }).Mounts ?? [];
    // Same volume, not a fresh one, otherwise the data would still be lost.
    expect(secondMounts.some((m) => m.Name === volume.name)).toBe(true);

    await removeVolume(volume.name).catch(() => undefined);
  }, 600_000);

  test('explains a broken repository instead of hanging', async () => {
    const broken = createAppService({
      projectId,
      name: 'broken',
      repoUrl: 'https://github.com/derailed-does-not-exist/nope-not-here',
      branch: 'main',
    });
    const deployment = await settle(queueDeployment(broken.id, 'manual').id, 120_000);

    expect(deployment.status).toBe('failed');
    expect(deployment.errorSummary).toContain("doesn't exist");
    expect(deployment.errorHint).toBeTruthy();
  }, 180_000);

  test('deploys a ready-made image, with no repository and no build', async () => {
    // The whole point: WordPress and friends should not need a wrapper repository
    // that contains a single-line Dockerfile.
    const service = createAppService({
      projectId,
      name: 'ready',
      source: 'image',
      image: 'nginx:1.27-alpine',
      repoUrl: null,
      branch: null,
      port: 80,
    });

    const deployment = await settle(queueDeployment(service.id, 'manual').id, 300_000);

    expect(deployment.status).toBe('running');
    // Ran the public image directly rather than building one of ours.
    expect(deployment.imageTag).toBe('nginx:1.27-alpine');
    expect(deployment.commitSha).toBeNull();

    const details = await inspectContainer(deployment.containerId!);
    expect(details?.Config.Image).toBe('nginx:1.27-alpine');

    const containers = await listContainers(labelFilter({ [LABELS.service]: service.id }));
    for (const container of containers) {
      await destroyContainer(container.Id, 5).catch(() => undefined);
    }
  }, 420_000);

  test('deploys a zip someone dragged in, with no git at all', async () => {
    // Someone with a folder on their laptop and no GitHub account.
    const zipDir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
    const zipPath = join(zipDir, 'site.zip');
    const proc = Bun.spawn(['zip', '-rq', zipPath, '.'], {
      cwd: join(import.meta.dir, 'fixtures/hello-dockerfile'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    const service = createAppService({
      projectId,
      name: 'dropped',
      source: 'upload',
      repoUrl: null,
      branch: null,
    });

    const stored = await storeUpload(
      service.id,
      new File([await Bun.file(zipPath).arrayBuffer()], 'site.zip'),
    );
    expect(stored.files).toBeGreaterThan(0);

    const deployment = await settle(queueDeployment(service.id, 'manual').id, 300_000);
    expect(deployment.status).toBe('running');
    // Nothing was cloned, so there is no commit to record.
    expect(deployment.commitSha).toBeNull();

    const containers = await listContainers(labelFilter({ [LABELS.service]: service.id }));
    for (const container of containers) {
      await destroyContainer(container.Id, 5).catch(() => undefined);
    }
    await removeUpload(service.id);
    await rm(zipDir, { recursive: true, force: true });
  }, 420_000);
});
