/**
 * Phase 4 against a real engine: create a PostgreSQL service from the catalog, wait
 * for the container to report healthy, connect an app to it, and check the app really
 * would receive working credentials, by connecting with them and running a query
 * from inside the project network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionUrl, createDatabaseFromCatalog, credentialsFor } from '../src/catalog/create.ts';
import { findEngine } from '../src/catalog/databases.ts';
import { connectServices, disconnectServices } from '../src/catalog/links.ts';
import { initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { listLinks } from '../src/db/repo/links.ts';
import { createProject } from '../src/db/repo/projects.ts';
import {
  containerName,
  createAppService,
  deleteService,
  findService,
} from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import {
  createContainer,
  destroyContainer,
  findContainerByName,
  inspectContainer,
  listContainers,
  startContainer,
} from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { LABELS, labelFilter, managedLabels } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { removeVolume } from '../src/docker/volumes.ts';
import { reconcileLiveStatus } from '../src/runtime/livestatus.ts';
import { serviceStatus } from '../src/runtime/present.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const dir = mkdtempSync(join(tmpdir(), 'derailed-catalog-'));
const RUN_ID = Math.random().toString(36).slice(2, 8);
const CLIENT_IMAGE = 'postgres:17-alpine';

let projectId = '';
let projectSlug = '';
let databaseId = '';
let appId = '';

suite('databases and links', () => {
  beforeAll(async () => {
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));

    const project = createProject(`Catalog ${RUN_ID}`);
    projectId = project.id;
    projectSlug = project.slug;

    appId = createAppService({
      projectId,
      name: 'web',
      repoUrl: 'https://github.com/example/app',
      branch: 'main',
    }).id;

    if (!(await imageExists(CLIENT_IMAGE))) await pullImage(CLIENT_IMAGE);
  }, 300_000);

  afterAll(async () => {
    if (databaseId) {
      const name = containerName(projectSlug, 'postgres');
      const existing = await findContainerByName(name).catch(() => null);
      if (existing) await destroyContainer(existing.Id, 5).catch(() => undefined);
      await removeVolume(`derailed-${databaseId}`).catch(() => undefined);
      deleteService(databaseId);
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
  }, 120_000);

  test('creates a PostgreSQL container from the catalog', async () => {
    const service = await createDatabaseFromCatalog(projectId, 'postgres', 'postgres', '17');
    databaseId = service.id;

    expect(service.kind).toBe('database');
    expect(service.dbEngine).toBe('postgres');
    expect(service.dbVersion).toBe('17');

    const container = await findContainerByName(containerName(projectSlug, service.slug));
    expect(container).not.toBeNull();
  }, 300_000);

  test('publishes nothing to the internet by default', async () => {
    const container = await findContainerByName(containerName(projectSlug, 'postgres'));
    const details = await inspectContainer(container!.Id);
    // A published port shows up here with a host binding; internal-only stays null.
    const published = Object.values(details?.NetworkSettings.Ports ?? {}).filter(Boolean);
    expect(published).toHaveLength(0);
  }, 60_000);

  test('reports healthy once Postgres has finished starting', async () => {
    const container = await findContainerByName(containerName(projectSlug, 'postgres'));
    const deadline = Date.now() + 150_000;
    let health = '';

    while (Date.now() < deadline) {
      const details = await inspectContainer(container!.Id);
      health = details?.State.Health?.Status ?? '';
      if (health === 'healthy') break;
      await Bun.sleep(1000);
    }

    expect(health).toBe('healthy');
  }, 180_000);

  test('the generated credentials actually work', async () => {
    const service = findService(databaseId)!;
    expect(credentialsFor(service)).not.toBeNull();

    const url = connectionUrl(service);
    expect(url).toContain('postgres://');

    // Run psql from a throwaway container on the project network, exactly the path
    // a deployed app takes to reach its database.
    const probe = `derailed-test-probe-${RUN_ID}`;
    const id = await createContainer({
      name: probe,
      image: CLIENT_IMAGE,
      cmd: ['psql', url!, '-tAc', 'select 42'],
      network: projectNetworkName(projectId),
      labels: managedLabels({ role: 'build' }),
      // createContainer defaults to `unless-stopped`, which is right for apps and
      // databases but would restart this one-shot probe forever.
      restartPolicy: 'no',
    });

    try {
      await startContainer(id);

      const deadline = Date.now() + 60_000;
      let exit: number | null = null;
      while (Date.now() < deadline) {
        const details = await inspectContainer(id);
        if (details && !details.State.Running && details.State.Status === 'exited') {
          exit = details.State.ExitCode;
          break;
        }
        await Bun.sleep(500);
      }

      expect(exit).toBe(0);
    } finally {
      await destroyContainer(id, 2).catch(() => undefined);
    }
  }, 180_000);

  test('reports Running once the container is up, not "Setting up" forever', async () => {
    // A database has no deployments, and status used to be derived only from those -
    // so a perfectly healthy database sat on "Setting up" indefinitely. Found on the
    // first real deployment, where Postgres was `Up (healthy)` and the UI disagreed.
    const containers = await listContainers(labelFilter({ [LABELS.service]: databaseId }));
    reconcileLiveStatus(containers.filter((c) => c.State === 'running').map(() => databaseId));

    expect(serviceStatus(findService(databaseId)!)).toBe('running');
  }, 60_000);

  test('connecting an app materialises a link-sourced variable', () => {
    const { key } = connectServices(appId, databaseId);
    expect(key).toBe('DATABASE_URL');

    const vars = listEnv(appId);
    const injected = vars.find((entry) => entry.key === 'DATABASE_URL');
    expect(injected).toBeDefined();
    expect(injected?.source).toBe('link');
    expect(injected?.value).toContain('postgres://');

    expect(listLinks(projectId)).toHaveLength(1);
  });

  test('refuses to connect the same pair twice', () => {
    expect(() => connectServices(appId, databaseId)).toThrow(/already connected/i);
  });

  test('refuses to connect an app to another app', () => {
    const other = createAppService({
      projectId,
      name: 'other',
      repoUrl: 'https://github.com/example/other',
      branch: 'main',
    });
    expect(() => connectServices(appId, other.id)).toThrow(/isn't a database/i);
    deleteService(other.id);
  });

  test('disconnecting removes the variable it added', () => {
    const link = listLinks(projectId)[0];
    expect(link).toBeDefined();

    disconnectServices(link!.id);

    expect(listEnv(appId).find((entry) => entry.key === 'DATABASE_URL')).toBeUndefined();
    expect(listLinks(projectId)).toHaveLength(0);
  });

  test('the catalog describes every engine the wizard offers', () => {
    for (const engine of ['postgres', 'mysql', 'redis']) {
      const found = findEngine(engine);
      expect(found).toBeDefined();
      expect(found?.versions.length).toBeGreaterThan(0);
      expect(found?.image(found.versions[0]!)).toContain(engine === 'postgres' ? 'postgres' : '');
    }
  });

  test('can also set separate host/port/user/password variables', async () => {
    // WordPress and plenty of others never read a connection URL, so a link that
    // only sets one silently does nothing useful.
    const { key } = connectServices(appId, databaseId, undefined, true);
    expect(key).toBe('DATABASE_URL');

    const names = listEnv(appId).map((entry) => entry.key);
    for (const suffix of ['HOST', 'PORT', 'NAME', 'USER', 'PASSWORD']) {
      expect(names).toContain(`DATABASE_${suffix}`);
    }

    const link = listLinks(projectId)[0]!;
    disconnectServices(link.id);

    // And they all go away again, not just the URL.
    const after = listEnv(appId).map((entry) => entry.key);
    expect(after).toHaveLength(0);
  });
});
