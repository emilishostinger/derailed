import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execArgs } from '../src/backup/backup.ts';
import { takeSnapshot } from '../src/backup/snapshots.ts';
import { activeJobCount, stopAllDeployments } from '../src/build/pipeline.ts';
import {
  createPreview,
  removePreview,
  setPreviewData,
  setPreviews,
} from '../src/build/previews.ts';
import { createDatabaseFromCatalog, credentialsFor } from '../src/catalog/create.ts';
import { connectServices } from '../src/catalog/links.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService, listServices } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { listVolumes, removeVolume } from '../src/docker/volumes.ts';
import { sleepSettingFor } from '../src/runtime/sleep.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Test on a copy, a real copy. A real Postgres with real rows, one hourly copy,
 * and a preview whose database is a clone: the rows are there, the scrub ran
 * against the copy and only the copy, and killing the branch takes the clone
 * with it while the real data never noticed anything at all.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping preview data integration tests');
}

let dir = '';
let projectId = '';
let appId = '';
let dbId = '';

async function sql(serviceId: string, query: string): Promise<string> {
  const service = findService(serviceId)!;
  const credentials = credentialsFor(service)!;
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId }));
  const running = containers.find((container) => container.State === 'running')!;
  const proc = Bun.spawn(
    [
      'docker',
      ...execArgs(running.Id, [`PGPASSWORD=${credentials.password}`]),
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

async function sqlEventually(
  serviceId: string,
  query: string,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await sql(serviceId, query);
    } catch (err) {
      lastError = err;
      await Bun.sleep(1000);
    }
  }
  throw lastError;
}

suite('a preview with its own copy of the data', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-previewdata-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));

    const project = createProject('Copies');
    projectId = project.id;

    const database = await createDatabaseFromCatalog(projectId, 'shopdata', 'postgres', '17');
    dbId = database.id;
    await sqlEventually(dbId, 'SELECT 1', 120_000);
    await sql(dbId, 'CREATE TABLE customers (name text, email text)');
    await sql(dbId, "INSERT INTO customers VALUES ('Ada', 'ada@example.com')");
    await sql(dbId, "INSERT INTO customers VALUES ('Grace', 'grace@example.com')");

    const app = createAppService({
      projectId,
      name: 'shop',
      repoUrl: 'https://github.com/example/shop',
      branch: 'main',
    });
    appId = app.id;
    await connectServices(appId, dbId);

    setPreviews(appId, true);
    setPreviewData(
      appId,
      'clone',
      // The scrub: real-shaped data without real people in it. Bare psql on
      // purpose: the copy's own name and user arrive in the environment.
      `psql -c "UPDATE customers SET email = 'hidden@example.invalid'"`,
    );
  }, 600_000);

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
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  let previewId = '';
  let cloneId = '';

  test('the preview gets a clone with the rows, scrubbed, and its own address in its variables', async () => {
    await takeSnapshot(dbId);
    previewId = (await createPreview(appId, 'feature/new-checkout'))!;
    expect(previewId).toBeTruthy();

    // The clone exists, is marked as a preview of the real database, and runs.
    const clone = listServices(projectId).find(
      (service) =>
        service.kind === 'database' && service.id !== dbId && service.name.includes('shopdata'),
    );
    expect(clone).toBeDefined();
    cloneId = clone!.id;

    // The rows came over; the scrub ran against the copy.
    expect(await sqlEventually(cloneId, 'SELECT count(*) FROM customers')).toBe('2');
    expect(await sql(cloneId, 'SELECT DISTINCT email FROM customers')).toBe(
      'hidden@example.invalid',
    );

    // And only the copy: the real data never noticed.
    expect(await sql(dbId, "SELECT email FROM customers WHERE name = 'Ada'")).toBe(
      'ada@example.com',
    );

    // The preview's variables point at the clone, not the real database.
    const url = listEnv(previewId).find((entry) => entry.key === 'DATABASE_URL');
    expect(url?.source).toBe('link');
    const cloneHost = credentialsFor(findService(cloneId)!)!.host;
    const realHost = credentialsFor(findService(dbId)!)!.host;
    expect(url?.value).toContain(cloneHost);
    expect(url?.value).not.toContain(`@${realHost}:`);

    // Occasional by nature: the preview naps after a quiet day.
    expect(sleepSettingFor(previewId)).toBe(24 * 60);
  }, 600_000);

  test('the branch dies, and the copy dies with it', async () => {
    await removePreview(previewId);
    expect(findService(previewId)).toBeNull();
    expect(findService(cloneId)).toBeNull();
    const containers = await listContainers(labelFilter({ [LABELS.service]: cloneId }));
    expect(containers.length).toBe(0);

    // The real database sailed through the whole story.
    expect(await sql(dbId, 'SELECT count(*) FROM customers')).toBe('2');
  }, 120_000);

  test('a failed scrub abandons the whole preview rather than serving production', async () => {
    setPreviewData(appId, 'clone', 'exit 7');
    const id = await createPreview(appId, 'feature/broken-scrub');

    // No preview at all: the app inherited the parent's real DATABASE_URL, so a
    // preview that deployed anyway would point straight at production. No preview
    // beats a preview aimed at production, so createPreview abandons it and the
    // clone it half-made.
    expect(id).toBeNull();
    const live = listServices(projectId).filter(
      (service) => service.kind === 'database' && service.id !== dbId,
    );
    expect(live.length).toBe(0);
  }, 600_000);
});
