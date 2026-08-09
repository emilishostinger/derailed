import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseFromCatalog } from '../src/catalog/create.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { removeNetwork } from '../src/docker/networks.ts';
import { tunnelTargetFor } from '../src/runtime/tunnel.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Where a real database answers, resolved from a running container.
 *
 * The byte-bridge itself is proven against an echo server in tunnel.test.ts,
 * because the piping is the same whatever answers. What only a container can
 * prove is that `tunnelTargetFor` reads the right address and port off a live
 * Postgres: its own IP on the project network (which a Linux server dials
 * directly), and 5432 from the catalogue rather than from anything a caller sent.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping tunnel integration tests');
}

let dir = '';
let projectId = '';

suite('a tunnel target', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-tunnel-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');
    projectId = createProject('Tunnel target').id;
  }, 120_000);

  afterAll(async () => {
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

  test('resolves a running Postgres to its network address and standard port', async () => {
    const database = await createDatabaseFromCatalog(projectId, 'shop', 'postgres', '16');
    // createDatabaseFromCatalog starts the container; give it a moment to attach.
    let target: Awaited<ReturnType<typeof tunnelTargetFor>> | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      target = await tunnelTargetFor(database.id).catch(() => null);
      if (target) break;
      await Bun.sleep(1000);
    }
    expect(target).not.toBeNull();
    expect(target!.port).toBe(5432);
    // A real IPv4 on the Docker network, which a Linux host can dial directly.
    expect(target!.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }, 120_000);

  test('refuses a database that is not running', async () => {
    const database = await createDatabaseFromCatalog(projectId, 'stopped', 'postgres', '16');
    const containers = await listContainers(labelFilter({ [LABELS.service]: database.id })).catch(
      () => [],
    );
    for (const container of containers) await destroyContainer(container.Id, 2).catch(() => {});
    await expect(tunnelTargetFor(database.id)).rejects.toThrow(/not running/i);
  }, 120_000);
});
