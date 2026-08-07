/**
 * Dropping a folder of code on the dashboard and getting a website.
 *
 * Node and Python are what most people actually write, and the promise this product
 * makes is that neither of them needs a Dockerfile from you. That promise is either
 * true end to end or it is marketing, and the only way to know is to build one of each
 * for real: a zip in, a container out, and an HTTP request that comes back with the
 * right words.
 *
 * Nothing here is mocked. Real uploads, real Nixpacks, real images, real containers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepo } from '../src/build/detect.ts';
import { queueDeployment, stopAllDeployments } from '../src/build/pipeline.ts';
import { storeUpload } from '../src/build/upload.ts';
import { initDb } from '../src/db/index.ts';
import { findDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, inspectContainer, listContainers } from '../src/docker/containers.ts';
import { removeImage } from '../src/docker/images.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let dir = '';
let projectId = '';

/** A Node app as somebody who has never written a Dockerfile would leave it. */
const NODE_APP: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'dropped-node', version: '1.0.0', scripts: { start: 'node server.js' } },
    null,
    2,
  ),
  'server.js': `const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('hello from a dropped node app');
}).listen(port);
`,
};

/** And a Python one. */
const PYTHON_APP: Record<string, string> = {
  'requirements.txt': 'flask==3.0.3\n',
  'main.py': `import os
from flask import Flask

app = Flask(__name__)


@app.route("/")
def home():
    return "hello from a dropped python app"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
`,
};

async function zipOf(name: string, files: Record<string, string>): Promise<File> {
  const source = join(dir, name);
  await mkdir(source, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(source, path), body);
  }
  const archive = join(dir, `${name}.zip`);
  const proc = Bun.spawn(['zip', '-qr', archive, '.'], { cwd: source, stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(`could not zip ${name}`);
  return new File([await Bun.file(archive).arrayBuffer()], `${name}.zip`);
}

/** Waits for a deployment to finish, however it finishes. */
async function settle(deploymentId: string, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (deployment?.finishedAt) return deployment;
    await Bun.sleep(1000);
  }
  throw new Error('deployment never finished');
}

/** Asks the container the same question a visitor would. */
async function fetchFrom(serviceId: string): Promise<string> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId }));
  const running = containers.find((entry) => entry.State === 'running');
  expect(running).toBeTruthy();

  const inspected = await inspectContainer(running!.Id);
  const ports = inspected?.NetworkSettings.Ports ?? {};
  const bound = Object.values(ports).find((binding) => binding?.[0]?.HostPort)?.[0]?.HostPort;
  expect(bound).toBeTruthy();

  const response = await fetch(`http://127.0.0.1:${bound}/`, {
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  return response.text();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'derailed-drop-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  setSetting(SETTINGS.serverIp, '203.0.113.9');
  projectId = createProject(`Dropped ${RUN}`).id;
}, 120_000);

afterAll(async () => {
  await stopAllDeployments();
  const containers = await listContainers(labelFilter({ [LABELS.project]: projectId }), true).catch(
    () => [],
  );
  for (const container of containers)
    await destroyContainer(container.Id, 1).catch(() => undefined);
  await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}, 240_000);

suite('a folder of code, dropped in', () => {
  test('a Node app with no Dockerfile is recognised as one', async () => {
    const source = join(dir, 'detect-node');
    await mkdir(source, { recursive: true });
    for (const [path, body] of Object.entries(NODE_APP)) await writeFile(join(source, path), body);

    const detected = await detectRepo({ dir: source, rootDir: null, dockerfilePath: null });
    expect(detected.strategy).toBe('nixpacks');
    expect(detected.framework).toContain('Node');
    expect(detected.port).toBe(3000);
    // The sentence somebody actually reads. It should name the thing and the port.
    expect(detected.summary).toContain('Node');
  });

  test('a Python app with no Dockerfile is recognised as one', async () => {
    const source = join(dir, 'detect-python');
    await mkdir(source, { recursive: true });
    for (const [path, body] of Object.entries(PYTHON_APP))
      await writeFile(join(source, path), body);

    const detected = await detectRepo({ dir: source, rootDir: null, dockerfilePath: null });
    expect(detected.strategy).toBe('nixpacks');
    expect(detected.framework).toContain('Python');
    expect(detected.port).toBe(8000);
  });

  test('the Node app builds, starts and answers', async () => {
    const service = createAppService({
      projectId,
      name: 'dropped-node',
      source: 'upload',
      repoUrl: null,
      branch: null,
    });
    await storeUpload(service.id, await zipOf('node-app', NODE_APP));

    const deployment = await settle(queueDeployment(service.id, 'manual').id);
    expect(deployment.status).toBe('running');
    expect(await fetchFrom(service.id)).toContain('hello from a dropped node app');

    if (deployment.imageTag) await removeImage(deployment.imageTag).catch(() => undefined);
  }, 480_000);

  test('the Python app builds, starts and answers', async () => {
    const service = createAppService({
      projectId,
      name: 'dropped-python',
      source: 'upload',
      repoUrl: null,
      branch: null,
    });
    await storeUpload(service.id, await zipOf('python-app', PYTHON_APP));

    const deployment = await settle(queueDeployment(service.id, 'manual').id);
    expect(deployment.status).toBe('running');
    expect(await fetchFrom(service.id)).toContain('hello from a dropped python app');

    if (deployment.imageTag) await removeImage(deployment.imageTag).catch(() => undefined);
  }, 480_000);
});
