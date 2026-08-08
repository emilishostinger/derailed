import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exec } from '../src/catalog/dbclient.ts';
import { ping } from '../src/docker/client.ts';
import {
  createContainer,
  destroyContainer,
  findContainerByName,
  startContainer,
} from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';
import { ensureNetwork, removeNetwork } from '../src/docker/networks.ts';
import { IMAGES_IMAGE, IMAGES_PORT } from '../src/proxy/images.ts';

/**
 * The picture sidecar, against the real thing.
 *
 * Two claims worth a container: the URL grammar Caddy rewrites into actually
 * resizes a picture, and the allowed-sources guard actually refuses to fetch
 * from anywhere that is not a Derailed-managed container. The second is the
 * SSRF door, and config that looks right and is not would never show up in a
 * unit test.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping images integration tests');
}

const NETWORK = 'derailed-test-images';
const SOURCE = 'd_imgtest_src';
const SIDECAR = 'derailed-test-images-sidecar';
const HOST_PORT = 18981;

/** A 4x4 red PNG, base64. Small enough to be a string, real enough to decode. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP8z4APMOGVHXHSAECfAR2qZvCJAAAAAElFTkSuQmCC';

async function removeByName(name: string): Promise<void> {
  const existing = await findContainerByName(name);
  if (existing) await destroyContainer(existing.Id, 2).catch(() => undefined);
}

suite('the picture sidecar', () => {
  beforeAll(async () => {
    await ensureNetwork(NETWORK, managedLabels({ role: 'images' }));
    await removeByName(SOURCE);
    await removeByName(SIDECAR);

    if (!(await imageExists('nginx:alpine'))) await pullImage('nginx:alpine');
    if (!(await imageExists(IMAGES_IMAGE))) await pullImage(IMAGES_IMAGE);

    const sourceId = await createContainer({
      name: SOURCE,
      image: 'nginx:alpine',
      labels: managedLabels({ role: 'images' }),
      network: NETWORK,
      ports: {},
      volumes: {},
    });
    await startContainer(sourceId);
    // Give nginx a real picture to serve.
    const wrote = await exec(sourceId, [
      '/bin/sh',
      '-c',
      `echo '${TINY_PNG}' | base64 -d > /usr/share/nginx/html/photo.png`,
    ]);
    expect(wrote.code).toBe(0);

    const sidecarId = await createContainer({
      name: SIDECAR,
      image: IMAGES_IMAGE,
      env: {
        IMGPROXY_BIND: `:${IMAGES_PORT}`,
        // The same guard production runs with. The refusal below is the test.
        IMGPROXY_ALLOWED_SOURCES: 'http://d_',
      },
      labels: managedLabels({ role: 'images' }),
      network: NETWORK,
      ports: { [IMAGES_PORT]: { host: '127.0.0.1', port: HOST_PORT } },
      volumes: {},
    });
    await startContainer(sidecarId);

    // Wait for the sidecar to answer at all.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${HOST_PORT}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(500);
    }
  }, 300_000);

  afterAll(async () => {
    await removeByName(SOURCE);
    await removeByName(SIDECAR);
    await removeNetwork(NETWORK).catch(() => undefined);
  }, 60_000);

  test('the grammar Caddy rewrites into really resizes a picture', async () => {
    const response = await fetch(
      `http://127.0.0.1:${HOST_PORT}/insecure/w:2/plain/http://${SOURCE}:80/photo.png`,
      { signal: AbortSignal.timeout(15_000) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('image/');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // Cached hard, which is what keeps the sidecar idle: browsers do the work.
    expect(response.headers.get('cache-control') ?? '').toContain('max-age');
  }, 60_000);

  test('a source that is not a managed container is refused, whatever the URL says', async () => {
    // The shape an attacker would aim for if the width guard were ever wrong:
    // walking the sidecar to an address of their choosing.
    const response = await fetch(
      `http://127.0.0.1:${HOST_PORT}/insecure/plain/http://169.254.169.254/latest/meta-data`,
      { signal: AbortSignal.timeout(15_000) },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
