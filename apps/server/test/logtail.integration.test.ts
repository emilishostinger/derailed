/**
 * Reading what a running app is printing.
 *
 * The point of this feature is that somebody whose site is misbehaving can see its
 * output without opening a terminal, so the test runs a real container that prints
 * real lines and checks they arrive: both in the backlog a freshly-opened tab asks
 * for, and live on the socket while it watches.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, destroyContainer, startContainer } from '../src/docker/containers.ts';
import { pullImage } from '../src/docker/images.ts';
import { LABELS } from '../src/docker/labels.ts';
import { addSubscriber } from '../src/events/bus.ts';
import { followService, recentLogs, stopFollowing } from '../src/runtime/logtail.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let dir = '';
let serviceId = '';
let containerId = '';

beforeAll(async () => {
  if (!dockerAvailable) return;
  dir = await mkdtemp(join(tmpdir(), 'derailed-logtail-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));

  const project = createProject(`Logs ${RUN}`);
  serviceId = createAppService({
    projectId: project.id,
    name: 'chatty',
    source: 'image',
    image: 'alpine:latest',
    repoUrl: null,
    branch: null,
  }).id;

  await pullImage('alpine:latest');
  // Says something every half second, forever, so there is always something to read.
  containerId = await createContainer({
    name: `derailed-test-logs-${RUN}`,
    image: 'alpine:latest',
    cmd: ['sh', '-c', 'i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 0.5; done'],
    labels: { [LABELS.managed]: 'true', [LABELS.service]: serviceId },
  });
  await startContainer(containerId);
}, 180_000);

afterAll(async () => {
  stopFollowing(serviceId);
  if (containerId) await destroyContainer(containerId, 1).catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}, 60_000);

suite('what an app is printing', () => {
  test('the backlog is there when the tab opens', async () => {
    await followService(serviceId);

    // Give the container a moment to say something worth reading.
    const deadline = Date.now() + 20_000;
    while (recentLogs(serviceId).length === 0 && Date.now() < deadline) {
      await Bun.sleep(250);
    }

    const lines = recentLogs(serviceId);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.line.includes('tick'))).toBe(true);
    // Stamped on arrival, and labelled as the app's own output rather than build
    // output, which is what lets one viewer show both without confusing them.
    expect(lines[0]!.ts).toBeGreaterThan(0);
    expect(lines[0]!.stream).toBe('runtime');
  }, 60_000);

  test('new lines arrive on the socket while you watch', async () => {
    const seen: string[] = [];
    const unsubscribe = addSubscriber({
      topics: new Set([topics.service(serviceId)]),
      send: (event: ServerEvent) => {
        if (event.type === 'service.logs') {
          for (const line of event.lines) seen.push(line.line);
        }
      },
    });

    try {
      await followService(serviceId);
      const deadline = Date.now() + 20_000;
      while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(250);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((line) => line.includes('tick'))).toBe(true);
    } finally {
      unsubscribe();
    }
  }, 60_000);

  test('it stops when told to, and does not keep reading', async () => {
    await followService(serviceId);
    stopFollowing(serviceId);

    const before = recentLogs(serviceId).length;
    await Bun.sleep(2000);
    // The tail is dropped entirely, so nothing is being accumulated behind the scenes
    // for an app nobody is looking at.
    expect(recentLogs(serviceId).length).toBeLessThanOrEqual(before);
  }, 30_000);
});
