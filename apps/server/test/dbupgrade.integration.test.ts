import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execArgs } from '../src/backup/backup.ts';
import { createDatabaseFromCatalog, credentialsFor } from '../src/catalog/create.ts';
import { pitrState, restoreToMoment, setPitr } from '../src/catalog/pitr.ts';
import { runDbUpgrade, sweepRetiredEngines } from '../src/catalog/upgrade.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { listDbUpgrades } from '../src/db/repo/dbupgrades.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { findService } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import {
  destroyContainer,
  findContainerByName,
  inspectContainer,
  listContainers,
} from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { listVolumes, removeVolume } from '../src/docker/volumes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * A real database growing up, and a real one wound back to a moment.
 *
 * Postgres 16 gets rows, moves to 17, and still has its rows. The old 16 engine
 * is kept, stopped, until its week is up. Then the point-in-time story end to
 * end: archive on, a row written, a moment named, a second row written, and a
 * wind-back that keeps the first row and has never heard of the second.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping database upgrade integration tests');
}

let dir = '';
let projectId = '';
let serviceId = '';

async function runningDbContainer(): Promise<string> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId }));
  const running = containers.find((container) => container.State === 'running');
  if (!running) throw new Error('database container not running');
  return running.Id;
}

async function sql(query: string): Promise<string> {
  const service = findService(serviceId)!;
  const credentials = credentialsFor(service)!;
  const containerId = await runningDbContainer();
  const proc = Bun.spawn(
    [
      'docker',
      ...execArgs(containerId, [`PGPASSWORD=${credentials.password}`]),
      'psql',
      '-U',
      credentials.user,
      '-d',
      credentials.dbName,
      '-tAc',
      query,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`psql failed: ${err}`);
  return out.trim();
}

/** psql refuses the moment the server is between states; asking again is the fix. */
async function sqlEventually(query: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await sql(query);
    } catch (err) {
      lastError = err;
      await Bun.sleep(1000);
    }
  }
  throw lastError;
}

suite('a database growing up, against real engines', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-dbupgrade-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));

    const project = createProject('Growing up');
    projectId = project.id;
    const service = await createDatabaseFromCatalog(projectId, 'shop', 'postgres', '16');
    serviceId = service.id;
    await sqlEventually('SELECT 1', 120_000);
    await sql('CREATE TABLE things (name text)');
    await sql("INSERT INTO things VALUES ('kept')");
  }, 600_000);

  afterAll(async () => {
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 1).catch(() => undefined);
    // Retired containers are renamed but keep their labels; volumes carry them too.
    const volumes = await listVolumes().catch(() => []);
    for (const volume of volumes) {
      if (volume.Labels?.[LABELS.service] === serviceId) {
        await removeVolume(volume.Name).catch(() => undefined);
      }
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  test('the copy comes first: a stopped database refuses to move', async () => {
    const containerId = await runningDbContainer();
    const { stopContainer, startContainer } = await import('../src/docker/containers.ts');
    await stopContainer(containerId, 20);

    const refused = await runDbUpgrade(serviceId, '17');
    expect(refused.status).toBe('failed');
    expect(refused.message).toContain('nothing was touched');

    await startContainer(containerId);
    await sqlEventually('SELECT 1');
  }, 300_000);

  test('16 to 17: rows survive, the old engine is kept, stopped', async () => {
    const upgrade = await runDbUpgrade(serviceId, '17');
    expect(upgrade.status).toBe('ok');
    expect(upgrade.snapshotId).not.toBeNull();

    expect(findService(serviceId)?.dbVersion).toBe('17');
    expect(await sqlEventually('SELECT version()')).toContain('PostgreSQL 17');
    expect(await sql('SELECT count(*) FROM things')).toBe('1');
    expect(await sql('SELECT name FROM things')).toBe('kept');

    // The way back is a real, whole, stopped container.
    const history = listDbUpgrades(serviceId);
    const kept = history.find((entry) => entry.id === upgrade.id)!;
    expect(kept.cleanupAfter).toBeGreaterThan(Date.now());
    const old = await findContainerByName(`${(await oldContainerName())!}`);
    expect(old).not.toBeNull();
    expect(old!.State).not.toBe('running');
  }, 600_000);

  test('a week later the old engine is tidied away', async () => {
    const oldName = await oldContainerName();
    const cleaned = await sweepRetiredEngines(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(cleaned).toBeGreaterThan(0);
    expect(await findContainerByName(oldName!)).toBeNull();
    // The database itself did not notice.
    expect(await sql('SELECT count(*) FROM things')).toBe('1');
  }, 120_000);

  test('point in time: a moment is a place you can go back to', async () => {
    const enabled = await setPitr(serviceId, true);
    expect(enabled.enabled).toBe(true);
    await sqlEventually('SELECT 1');
    expect((await pitrState(serviceId)).oldestMoment).not.toBeNull();

    await sql("INSERT INTO things VALUES ('before the moment')");
    await Bun.sleep(1500);
    const moment = Date.now();
    await Bun.sleep(1500);
    await sql("INSERT INTO things VALUES ('after the moment')");
    expect(await sql('SELECT count(*) FROM things')).toBe('3');

    await restoreToMoment(serviceId, moment);
    await sqlEventually('SELECT 1', 120_000);

    const names = await sql('SELECT name FROM things ORDER BY name');
    expect(names).toContain('kept');
    expect(names).toContain('before the moment');
    expect(names).not.toContain('after the moment');
  }, 600_000);

  test('and the archive can be turned off again', async () => {
    const disabled = await setPitr(serviceId, false);
    expect(disabled.enabled).toBe(false);
    await sqlEventually('SELECT 1');
    expect(await sql('SELECT count(*) FROM things')).toBe('2');
  }, 300_000);
});

async function oldContainerName(): Promise<string | null> {
  const history = listDbUpgrades(serviceId);
  for (const entry of history) {
    if (entry.status === 'ok' && entry.fromVersion !== entry.toVersion) {
      // The name is internal bookkeeping; read it straight from the table.
      const { db } = await import('../src/db/index.ts');
      const row = db()
        .query<{ old_container: string | null }, [string]>(
          'SELECT old_container FROM db_upgrades WHERE id = ?',
        )
        .get(entry.id);
      return row?.old_container ?? null;
    }
  }
  return null;
}
