import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups } from '../src/backup/backup.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import {
  createAppUpdate,
  findAppUpdate,
  latestRevertibleUpdate,
  listAppUpdates,
  updateAppUpdate,
} from '../src/db/repo/appupdates.ts';
import { createDeployment, findDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, createDatabaseService, findService } from '../src/db/repo/services.ts';
import { mayCall } from '../src/http/permissions.ts';
import {
  beginAppUpdate,
  revertAppUpdate,
  runAppUpdate,
  setAutoUpdate,
} from '../src/system/appupdate.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Updates that take a backup first.
 *
 * The order is the feature: the copy is taken before anything is pulled, the new
 * version has to answer before it takes over, and the way back is written down by
 * digest. Everything here that can be proven without Docker is proven here; the
 * full walk-through with real containers is in appupdate.integration.test.ts.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'derailed-appupdate-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function anImageApp(image = 'nginx:alpine') {
  const project = createProject('Shop');
  const app = createAppService({
    projectId: project.id,
    name: 'blog',
    source: 'image',
    image,
    repoUrl: null,
    branch: null,
    port: 80,
  });
  return { project, app };
}

function aRepoApp() {
  const project = createProject('Code');
  return createAppService({
    projectId: project.id,
    name: 'api',
    repoUrl: 'https://github.com/example/api',
    branch: 'main',
  });
}

describe('the record of an update', () => {
  test('starts as backing-up, with the way back written down first', () => {
    const { app } = anImageApp();
    const update = createAppUpdate(app.id, 'manual', 'nginx@sha256:aaaa');
    expect(update.status).toBe('backing-up');
    expect(update.fromRef).toBe('nginx@sha256:aaaa');
    expect(update.backupId).toBeNull();
    expect(findAppUpdate(update.id)?.id).toBe(update.id);
  });

  test('remembers each stage it moved through', () => {
    const { app } = anImageApp();
    const update = createAppUpdate(app.id, 'auto', null);
    updateAppUpdate(update.id, { backupId: 'shop-2026', status: 'deploying' });
    updateAppUpdate(update.id, { status: 'ok', toRef: 'nginx@sha256:bbbb', finishedAt: 5 });

    const finished = findAppUpdate(update.id)!;
    expect(finished.status).toBe('ok');
    expect(finished.backupId).toBe('shop-2026');
    expect(finished.toRef).toBe('nginx@sha256:bbbb');
    expect(finished.trigger).toBe('auto');
  });

  test('history reads newest first', () => {
    const { app } = anImageApp();
    const first = createAppUpdate(app.id, 'manual', null);
    const second = createAppUpdate(app.id, 'manual', null);
    updateAppUpdate(first.id, { finishedAt: 1 });
    const history = listAppUpdates(app.id);
    expect(history.map((entry) => entry.id)).toContain(first.id);
    expect(history[0]!.id).toBe(second.id);
  });
});

describe('which update "put it back" goes back to', () => {
  test('the newest finished one that knows what was running', () => {
    const { app } = anImageApp();
    const older = createAppUpdate(app.id, 'manual', 'nginx@sha256:aaaa');
    updateAppUpdate(older.id, { status: 'ok' });
    const newer = createAppUpdate(app.id, 'manual', 'nginx@sha256:bbbb');
    updateAppUpdate(newer.id, { status: 'failed' });

    expect(latestRevertibleUpdate(app.id)?.fromRef).toBe('nginx@sha256:bbbb');
  });

  test('never one still running, already reverted, or with nothing recorded', () => {
    const { app } = anImageApp();
    const running = createAppUpdate(app.id, 'manual', 'nginx@sha256:aaaa');
    expect(latestRevertibleUpdate(app.id)).toBeNull();

    updateAppUpdate(running.id, { status: 'reverted' });
    expect(latestRevertibleUpdate(app.id)).toBeNull();

    const amnesiac = createAppUpdate(app.id, 'manual', null);
    updateAppUpdate(amnesiac.id, { status: 'ok' });
    expect(latestRevertibleUpdate(app.id)).toBeNull();
  });

  test('with nothing to go back to, reverting says so in plain language', async () => {
    const { app } = anImageApp();
    await expect(revertAppUpdate(app.id)).rejects.toThrow('no recorded version');
  });
});

describe('what may be updated this way', () => {
  test('an app from a repository is deployed, not updated', async () => {
    const app = aRepoApp();
    await expect(beginAppUpdate(app.id)).rejects.toThrow('deploying it');
  });

  test('a missing app is said to be missing', async () => {
    await expect(beginAppUpdate('nope')).rejects.toThrow('no longer exists');
  });

  test('a database is not an app', async () => {
    const project = createProject('Data');
    const database = createDatabaseService({
      projectId: project.id,
      name: 'db',
      engine: 'postgres',
      version: '17',
      dbName: 'shop',
      dbUser: 'derailed',
      dbPassword: 'secret',
      port: 5432,
    });
    await expect(beginAppUpdate(database.id)).rejects.toThrow();
  });
});

describe('the automatic toggle', () => {
  test('turns on for an image app and reads back on the service', () => {
    const { app } = anImageApp();
    expect(findService(app.id)?.autoUpdate).toBe(false);
    setAutoUpdate(app.id, true);
    expect(findService(app.id)?.autoUpdate).toBe(true);
    setAutoUpdate(app.id, false);
    expect(findService(app.id)?.autoUpdate).toBe(false);
  });

  test('is refused for a repository app, with the alternative named', () => {
    const app = aRepoApp();
    expect(() => setAutoUpdate(app.id, true)).toThrow('ready-made image');
    // Turning it off is always allowed: a stale flag must never be stuck on.
    expect(() => setAutoUpdate(app.id, false)).not.toThrow();
  });
});

describe('the widened deployment triggers', () => {
  test("'update' and 'auto-update' are valid rows, not CHECK violations", () => {
    const { app } = anImageApp();
    const manual = createDeployment(app.id, 'update');
    const auto = createDeployment(app.id, 'auto-update');
    expect(findDeployment(manual.id)?.trigger).toBe('update');
    expect(findDeployment(auto.id)?.trigger).toBe('auto-update');
  });
});

describe('who may update', () => {
  test('updating and reverting are a member’s business, like deploying', () => {
    expect(mayCall('member', 'POST', '/api/services/x/update').ok).toBe(true);
    expect(mayCall('member', 'POST', '/api/services/x/update/revert').ok).toBe(true);
    expect(mayCall('member', 'PUT', '/api/services/x/auto-update').ok).toBe(true);
  });

  test('a viewer may look at update history but change nothing', () => {
    expect(mayCall('viewer', 'GET', '/api/services/x/update').ok).toBe(true);
    expect(mayCall('viewer', 'POST', '/api/services/x/update').ok).toBe(false);
    expect(mayCall('viewer', 'POST', '/api/services/x/update/revert').ok).toBe(false);
    expect(mayCall('viewer', 'PUT', '/api/services/x/auto-update').ok).toBe(false);
  });
});

describe('the copy comes first', () => {
  test('a fetch that fails still leaves the backup taken, and the app untouched', async () => {
    // An image that cannot exist, so the pull fails whether or not Docker is up.
    // What matters is the order the row proves: the backup id was written before
    // the pull was attempted, and the failure message says nothing was touched.
    const { app } = anImageApp('derailed-test/does-not-exist:v1');
    const update = await runAppUpdate(app.id);

    expect(update.status).toBe('failed');
    expect(update.backupId).not.toBeNull();
    expect(update.message).toContain('not touched');

    const backups = await listBackups();
    expect(backups.map((backup) => backup.id)).toContain(update.backupId!);
  }, 120_000);

  test('a second press while one runs is turned away', async () => {
    const { app } = anImageApp('derailed-test/does-not-exist:v2');
    const { done } = await beginAppUpdate(app.id);
    await expect(beginAppUpdate(app.id)).rejects.toThrow('already being updated');
    await done;
    // And once it has settled, the app can be updated again.
    const again = await runAppUpdate(app.id);
    expect(again.status).toBe('failed');
  }, 120_000);
});
