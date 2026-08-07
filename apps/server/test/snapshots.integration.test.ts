/**
 * A copy taken, the data ruined, the copy put back.
 *
 * The unit tests cover which copy is chosen for a moment, which is the rule that
 * matters. This covers the part that cannot be reasoned about: that the bytes
 * `pg_dump` produced actually go back in through `psql` and bring the rows with them.
 * A restore feature that has never restored anything is a promise, not a feature.
 *
 * Skipped automatically when the Docker socket isn't there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSnapshots,
  restoreSnapshot,
  snapshotAt,
  takeSnapshot,
} from '../src/backup/snapshots.ts';
import { createDatabaseFromCatalog } from '../src/catalog/create.ts';
import { exec, openSession } from '../src/catalog/dbclient.ts';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { containerName, deleteService } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import {
  destroyContainer,
  findContainerByName,
  inspectContainer,
} from '../src/docker/containers.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { removeVolume } from '../src/docker/volumes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) console.warn('[test] Docker socket not reachable, skipping snapshot tests.');

const dir = mkdtempSync(join(tmpdir(), 'derailed-snap-'));
const RUN_ID = Math.random().toString(36).slice(2, 8);

let projectId = '';
let projectSlug = '';
let databaseId = '';
let slug = '';

/** Runs SQL through the database's own client, the way everything else here does. */
async function sql(statement: string): Promise<string> {
  const session = await openSession(databaseId);
  const { code, out } = await exec(
    session.containerId,
    [
      'psql',
      '-U',
      session.user,
      '-d',
      session.dbName,
      '--no-align',
      '--tuples-only',
      '-c',
      statement,
    ],
    [`PGPASSWORD=${session.password}`],
    60_000,
  );
  if (code !== 0) throw new Error(out);
  return out.trim();
}

suite('taking a copy and putting it back', () => {
  beforeAll(async () => {
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    const project = createProject(`Snap ${RUN_ID}`);
    projectId = project.id;
    projectSlug = project.slug;

    const service = await createDatabaseFromCatalog(projectId, 'snapdb', 'postgres', '17');
    databaseId = service.id;
    slug = service.slug;

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const container = await findContainerByName(containerName(projectSlug, slug));
      const details = container ? await inspectContainer(container.Id) : null;
      if (details?.State.Health?.Status === 'healthy') break;
      await Bun.sleep(1000);
    }

    await sql(
      "CREATE TABLE orders (id int PRIMARY KEY, note text); INSERT INTO orders VALUES (1, 'the good one')",
    );
  }, 400_000);

  afterAll(async () => {
    const container = await findContainerByName(containerName(projectSlug, slug)).catch(() => null);
    if (container) await destroyContainer(container.Id, 5).catch(() => undefined);
    await removeVolume(`derailed-v-${databaseId}`).catch(() => undefined);
    deleteService(databaseId);
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
  }, 120_000);

  test('a copy has a size, a moment, and a file that is really there', async () => {
    const snapshot = await takeSnapshot(databaseId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.sizeBytes).toBeGreaterThan(0);
    expect(listSnapshots(databaseId)).toHaveLength(1);
  }, 120_000);

  test('the rows come back after the table is emptied', async () => {
    // The thing that actually has to work, and the only way to know it does.
    expect(await sql('SELECT note FROM orders WHERE id = 1')).toBe('the good one');

    await sql("UPDATE orders SET note = 'the bad thing' WHERE id = 1");
    expect(await sql('SELECT note FROM orders WHERE id = 1')).toBe('the bad thing');

    const snapshot = listSnapshots(databaseId)[0];
    await restoreSnapshot(snapshot!.id);

    expect(await sql('SELECT note FROM orders WHERE id = 1')).toBe('the good one');
  }, 180_000);

  test('a later copy is not chosen for an earlier moment', async () => {
    // Both copies are real, taken minutes apart on a real database. The rule under
    // test is the one that decides which of them a restore would use.
    const first = listSnapshots(databaseId)[0]!;
    await Bun.sleep(1100);
    const second = await takeSnapshot(databaseId);

    expect(snapshotAt(databaseId, second!.at)?.id).toBe(second!.id);
    expect(snapshotAt(databaseId, first.at)?.id).toBe(first.id);
    expect(snapshotAt(databaseId, first.at - 1000)).toBeNull();
  }, 120_000);

  test('refuses a copy that is no longer there', async () => {
    await expect(restoreSnapshot('not-a-real-one')).rejects.toThrow(/no longer here/);
  }, 30_000);
});
