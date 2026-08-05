/**
 * Integration tests against a real Docker Engine. Skipped automatically when the
 * socket isn't there, so `bun test` still works on a machine without Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ping } from '../src/docker/client.ts';
import {
  connectToNetwork,
  containerStats,
  createContainer,
  destroyContainer,
  findContainerByName,
  inspectContainer,
  listContainers,
  startContainer,
  stopContainer,
} from '../src/docker/containers.ts';
import { watchContainerEvents } from '../src/docker/events.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { LABELS, labelFilter, managedLabels } from '../src/docker/labels.ts';
import { streamContainerLogs } from '../src/docker/logs.ts';
import { ensureNetwork, networkExists, removeNetwork } from '../src/docker/networks.ts';
import { ensureVolume, listVolumes, removeVolume } from '../src/docker/volumes.ts';
import { statusFromEvent } from '../src/runtime/monitor.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const IMAGE = 'alpine:3.20';
const RUN_ID = Math.random().toString(36).slice(2, 8);
const NETWORK = `derailed-test-net-${RUN_ID}`;
const VOLUME = `derailed-test-vol-${RUN_ID}`;
const PROJECT_ID = `testproj${RUN_ID}`;
const SERVICE_ID = `testsvc${RUN_ID}`;

const created: string[] = [];

async function run(name: string, cmd: string[], extra: Record<string, unknown> = {}) {
  const id = await createContainer({
    name,
    image: IMAGE,
    cmd,
    labels: managedLabels({ projectId: PROJECT_ID, serviceId: SERVICE_ID, role: 'app' }),
    network: NETWORK,
    restartPolicy: 'no',
    ...extra,
  });
  created.push(id);
  await startContainer(id);
  return id;
}

if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping integration tests.');
}

suite('docker engine integration', () => {
  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    await ensureNetwork(NETWORK, managedLabels({ projectId: PROJECT_ID, role: 'app' }));
    await ensureVolume(VOLUME, managedLabels({ projectId: PROJECT_ID, role: 'app' }));
  }, 180_000);

  afterAll(async () => {
    for (const id of created) await destroyContainer(id, 1).catch(() => undefined);
    await removeVolume(VOLUME).catch(() => undefined);
    await removeNetwork(NETWORK).catch(() => undefined);
  }, 120_000);

  test('creates networks idempotently', async () => {
    await ensureNetwork(NETWORK, managedLabels({ role: 'app' }));
    expect(await networkExists(NETWORK)).toBe(true);
  });

  test('creates volumes and labels them', async () => {
    const volumes = await listVolumes(labelFilter({ [LABELS.project]: PROJECT_ID }));
    expect(volumes.map((v) => v.Name)).toContain(VOLUME);
  });

  test('runs a container and reads its labels back', async () => {
    const name = `derailed-test-labels-${RUN_ID}`;
    const id = await run(name, ['sleep', '30']);

    const inspected = await inspectContainer(id);
    expect(inspected?.State.Running).toBe(true);
    expect(inspected?.Config.Labels[LABELS.service]).toBe(SERVICE_ID);
    expect(inspected?.NetworkSettings.Networks[NETWORK]).toBeDefined();

    expect(await findContainerByName(name)).not.toBeNull();
  }, 60_000);

  test('only lists containers Derailed manages', async () => {
    const managed = await listContainers();
    expect(managed.every((c) => c.Labels?.[LABELS.managed] === 'true')).toBe(true);
    expect(managed.some((c) => c.Labels?.[LABELS.service] === SERVICE_ID)).toBe(true);
  });

  test('streams and demultiplexes container logs', async () => {
    const id = await run(`derailed-test-logs-${RUN_ID}`, [
      'sh',
      '-c',
      'echo hello-stdout; echo hello-stderr 1>&2; sleep 1',
    ]);
    await Bun.sleep(1200);

    const lines: string[] = [];
    for await (const entry of streamContainerLogs(id, { tail: 50 })) lines.push(entry.line);

    expect(lines).toContain('hello-stdout');
    expect(lines).toContain('hello-stderr');
  }, 60_000);

  test('samples cpu and memory', async () => {
    const id = await run(`derailed-test-stats-${RUN_ID}`, ['sleep', '30']);
    const stats = await containerStats(id);
    expect(stats).not.toBeNull();
    expect(stats!.memoryBytes).toBeGreaterThan(0);
    expect(stats!.cpuPercent).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test('connects a running container to another network', async () => {
    const second = `${NETWORK}-b`;
    await ensureNetwork(second, managedLabels({ role: 'proxy' }));
    const id = await run(`derailed-test-net-${RUN_ID}`, ['sleep', '30']);
    await connectToNetwork(id, second, ['alias-one']);
    await connectToNetwork(id, second, ['alias-one']); // idempotent

    const inspected = await inspectContainer(id);
    expect(inspected?.NetworkSettings.Networks[second]).toBeDefined();
    await destroyContainer(id, 1);
    await removeNetwork(second);
  }, 60_000);

  test('reports a crash on the event stream within two seconds', async () => {
    const seen: { status: string | null; serviceId: string | null }[] = [];
    const stop = watchContainerEvents((event) => {
      seen.push({ status: statusFromEvent(event), serviceId: event.serviceId });
    });
    await Bun.sleep(500); // let the watcher attach

    const id = await run(`derailed-test-crash-${RUN_ID}`, ['sh', '-c', 'sleep 0.3; exit 3']);

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (seen.some((e) => e.status === 'crashed' && e.serviceId === SERVICE_ID)) break;
      await Bun.sleep(50);
    }
    stop();

    expect(seen.some((e) => e.status === 'crashed' && e.serviceId === SERVICE_ID)).toBe(true);
    await destroyContainer(id, 1);
  }, 60_000);

  test('a clean stop reads as stopped, not crashed', async () => {
    const seen: (string | null)[] = [];
    const stop = watchContainerEvents((event) => seen.push(statusFromEvent(event)));
    await Bun.sleep(500);

    const id = await run(`derailed-test-stop-${RUN_ID}`, ['sleep', '60']);
    await stopContainer(id, 1);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !seen.includes('stopped')) await Bun.sleep(50);
    stop();

    expect(seen).toContain('stopped');
    expect(seen).not.toContain('crashed');
    await destroyContainer(id, 1);
  }, 60_000);

  test('destroying a container that is already gone is not an error', async () => {
    const id = await run(`derailed-test-gone-${RUN_ID}`, ['sleep', '5']);
    await destroyContainer(id, 1);
    await destroyContainer(id, 1);
    expect(await inspectContainer(id)).toBeNull();
  }, 60_000);
});
