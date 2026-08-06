/**
 * Drives a real Caddy container: start it, push a config, and check that a request
 * with the right Host header actually reaches the upstream container.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { caddy as caddyConfig } from '../src/config.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, destroyContainer, startContainer } from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';
import { ensureNetwork, removeNetwork } from '../src/docker/networks.ts';
import { removeVolume } from '../src/docker/volumes.ts';
import {
  attachCaddyToNetwork,
  buildCaddyConfig,
  ensureCaddyRunning,
  pingCaddy,
  pushCaddyConfig,
  removeCaddy,
} from '../src/proxy/caddy.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const APP_NETWORK = `derailed-test-app-${RUN_ID}`;
const UPSTREAM = `derailed-test-upstream-${RUN_ID}`;
const UPSTREAM_IMAGE = 'nginx:1.27-alpine';
const HOSTNAME = 'testapp.127-0-0-1.sslip.io';

let upstreamId = '';

suite('caddy integration', () => {
  beforeAll(async () => {
    if (!(await imageExists(UPSTREAM_IMAGE))) await pullImage(UPSTREAM_IMAGE);
    await ensureNetwork(APP_NETWORK, managedLabels({ role: 'app' }));

    upstreamId = await createContainer({
      name: UPSTREAM,
      image: UPSTREAM_IMAGE,
      labels: managedLabels({ role: 'app' }),
      network: APP_NETWORK,
      aliases: [UPSTREAM],
      restartPolicy: 'no',
    });
    await startContainer(upstreamId);

    await ensureCaddyRunning();
    await attachCaddyToNetwork(APP_NETWORK);
  }, 300_000);

  afterAll(async () => {
    if (upstreamId) await destroyContainer(upstreamId, 1).catch(() => undefined);
    await removeCaddy().catch(() => undefined);
    await removeVolume(caddyConfig.dataVolume).catch(() => undefined);
    await removeVolume(`${caddyConfig.dataVolume}-config`).catch(() => undefined);
    await removeNetwork(APP_NETWORK).catch(() => undefined);
    await removeNetwork(caddyConfig.network).catch(() => undefined);
  }, 180_000);

  test('the admin API answers', async () => {
    expect(await pingCaddy()).toBe(true);
  });

  test('starting twice adopts the running container', async () => {
    await ensureCaddyRunning();
    expect(await pingCaddy()).toBe(true);
  }, 60_000);

  test('routes a hostname to the upstream container', async () => {
    await pushCaddyConfig(
      buildCaddyConfig([{ hostname: HOSTNAME, upstream: UPSTREAM, port: 80, https: false }]),
    );

    // Caddy applies config asynchronously; give it a moment to start listening.
    let response: Response | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${caddyConfig.httpPort}/`, {
          headers: { host: HOSTNAME },
          signal: AbortSignal.timeout(3000),
          redirect: 'manual',
        });
        if (response.status !== 502 && response.status !== 503) break;
      } catch {
        // not listening yet
      }
      await Bun.sleep(400);
    }

    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain('nginx');
  }, 60_000);

  test("an unknown hostname gets the plain-language 404, not someone else's app", async () => {
    const response = await fetch(`http://127.0.0.1:${caddyConfig.httpPort}/`, {
      headers: { host: 'nobody.example.com' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Nothing is set up at this web address yet');
  }, 30_000);

  test('pushing a config with no routes stops serving the old hostname', async () => {
    await pushCaddyConfig(buildCaddyConfig([]));
    await Bun.sleep(500);
    const response = await fetch(`http://127.0.0.1:${caddyConfig.httpPort}/`, {
      headers: { host: HOSTNAME },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    }).catch(() => null);
    expect(response?.status).toBe(404);
  }, 30_000);

  /**
   * Caddy saves its own configuration and `--resume` loads it back, including the
   * address its admin API listens on. So moving that address left a Caddy running
   * happily on the old one and Derailed unable to say a word to it: routes stopped
   * updating, certificates stopped being requested, and the only symptom was a
   * router marked down with nothing anywhere saying why. It has to notice and
   * rebuild instead of adopting something it cannot talk to.
   */
  test('a running Caddy that cannot be reached is replaced, not adopted', async () => {
    const stranded = buildCaddyConfig([]);
    // Move the admin API somewhere Derailed will not look, exactly as an upgrade
    // that changes the admin address would.
    stranded.admin = { listen: '0.0.0.0:12931' };
    await pushCaddyConfig(stranded);

    await Bun.sleep(1000);
    expect(await pingCaddy()).toBe(false);

    await ensureCaddyRunning();
    expect(await pingCaddy()).toBe(true);

    // The rebuilt Caddy starts blank, so this is the push `reconcile()` does at
    // boot. That it succeeds at all is the point: before, it could not.
    await pushCaddyConfig(buildCaddyConfig([]));
    await Bun.sleep(500);

    // And it is serving again, rather than merely answering the admin API.
    const response = await fetch(`http://127.0.0.1:${caddyConfig.httpPort}/`, {
      headers: { host: 'nobody.example.com' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    }).catch(() => null);
    expect(response?.status).toBe(404);
  }, 180_000);
});
