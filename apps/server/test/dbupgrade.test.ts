import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pitrState, restoreToMoment, setPitr } from '../src/catalog/pitr.ts';
import { beginDbUpgrade, compareVersions, upgradeTargets } from '../src/catalog/upgrade.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import {
  createDbUpgrade,
  listDbUpgrades,
  updateDbUpgrade,
  upgradesDueCleanup,
} from '../src/db/repo/dbupgrades.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, createDatabaseService, updateService } from '../src/db/repo/services.ts';
import { mayCall } from '../src/http/permissions.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Growing a database up, everything provable without a container: which moves
 * are offered, which are refused and why, and the bookkeeping of what is kept.
 * The real dump-reload-verify walk is in dbupgrade.integration.test.ts.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'derailed-dbupgrade-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function aDatabase(engine = 'postgres', version = '16') {
  const project = createProject('Data');
  return createDatabaseService({
    projectId: project.id,
    name: 'db',
    engine,
    version,
    dbName: 'shop',
    dbUser: 'derailed',
    dbPassword: 'secret',
    port: 5432,
  });
}

describe('version arithmetic', () => {
  test('compares part by part, not as text', () => {
    // As text, "10.11" sorts before "8.4". As a version it does not.
    expect(compareVersions('10.11', '8.4')).toBeGreaterThan(0);
    expect(compareVersions('11.8', '11.4')).toBeGreaterThan(0);
    expect(compareVersions('16', '15')).toBeGreaterThan(0);
    expect(compareVersions('8.0', '8.0')).toBe(0);
    expect(compareVersions('7.4', '8')).toBeLessThan(0);
  });

  test('offers only the versions above, newest first', () => {
    expect(upgradeTargets(aDatabase('postgres', '16'))).toEqual(['18', '17']);
    expect(upgradeTargets(aDatabase('mariadb', '10.11'))).toEqual(['11.8', '11.4']);
  });

  test('the newest version has nowhere to go', () => {
    expect(upgradeTargets(aDatabase('postgres', '18'))).toEqual([]);
  });
});

describe('what an upgrade refuses, in plain language', () => {
  test('a version Derailed does not run', async () => {
    const database = aDatabase('postgres', '16');
    await expect(beginDbUpgrade(database.id, '99')).rejects.toThrow("can't run");
  });

  test('the version it is already on, and anything below', async () => {
    const database = aDatabase('postgres', '16');
    await expect(beginDbUpgrade(database.id, '16')).rejects.toThrow('already on');
    await expect(beginDbUpgrade(database.id, '15')).rejects.toThrow('already on');
  });

  test('an app is not a database', async () => {
    const project = createProject('Code');
    const app = createAppService({
      projectId: project.id,
      name: 'api',
      repoUrl: 'https://github.com/example/api',
      branch: 'main',
    });
    await expect(beginDbUpgrade(app.id, '17')).rejects.toThrow('no longer exists');
  });

  test('a database with the point-in-time archive on, until it is turned off', async () => {
    const database = aDatabase('postgres', '16');
    updateService(database.id, { walArchive: true });
    await expect(beginDbUpgrade(database.id, '17')).rejects.toThrow('archive');
  });
});

describe('the record of what is kept', () => {
  test('cleanup finds exactly the finished rows whose week is up', () => {
    const database = aDatabase();
    const done = createDbUpgrade(database.id, '15', '16');
    updateDbUpgrade(done.id, {
      status: 'ok',
      oldContainer: 'd_p_db-old-15',
      oldVolume: 'derailed-v-x',
      cleanupAfter: Date.now() - 1000,
    });
    const early = createDbUpgrade(database.id, '16', '17');
    updateDbUpgrade(early.id, { status: 'ok', cleanupAfter: Date.now() + 60_000 });
    const failed = createDbUpgrade(database.id, '16', '17');
    updateDbUpgrade(failed.id, { status: 'failed', cleanupAfter: Date.now() - 1000 });

    const due = upgradesDueCleanup();
    expect(due.map((entry) => entry.id)).toEqual([done.id]);
    expect(due[0]!.oldContainer).toBe('d_p_db-old-15');

    updateDbUpgrade(done.id, { cleanedAt: Date.now() });
    expect(upgradesDueCleanup().length).toBe(0);
  });

  test('history reads newest first', () => {
    const database = aDatabase();
    createDbUpgrade(database.id, '15', '16');
    const second = createDbUpgrade(database.id, '16', '17');
    expect(listDbUpgrades(database.id)[0]!.id).toBe(second.id);
  });
});

describe('the honest edges of point-in-time', () => {
  test('only Postgres has it, and the answer says so without being an error', async () => {
    const mysql = aDatabase('mysql', '8.0');
    const state = await pitrState(mysql.id);
    expect(state.supported).toBe(false);
    await expect(setPitr(mysql.id, true)).rejects.toThrow('PostgreSQL');
  });

  test('winding back needs the archive to be on', async () => {
    const database = aDatabase('postgres', '16');
    await expect(restoreToMoment(database.id, Date.now() - 1000)).rejects.toThrow('not on');
  });

  test('a moment in the future has not happened yet', async () => {
    const database = aDatabase('postgres', '16');
    updateService(database.id, { walArchive: true });
    await expect(restoreToMoment(database.id, Date.now() + 60_000)).rejects.toThrow('not happened');
  });
});

describe('who may move a database', () => {
  test('a member may, the same as restoring an hourly copy', () => {
    expect(mayCall('member', 'POST', '/api/services/x/upgrade').ok).toBe(true);
    expect(mayCall('member', 'PUT', '/api/services/x/pitr').ok).toBe(true);
    expect(mayCall('member', 'POST', '/api/services/x/pitr/restore').ok).toBe(true);
  });

  test('a viewer may only look', () => {
    expect(mayCall('viewer', 'GET', '/api/services/x/upgrade').ok).toBe(true);
    expect(mayCall('viewer', 'GET', '/api/services/x/pitr').ok).toBe(true);
    expect(mayCall('viewer', 'POST', '/api/services/x/upgrade').ok).toBe(false);
    expect(mayCall('viewer', 'PUT', '/api/services/x/pitr').ok).toBe(false);
    expect(mayCall('viewer', 'POST', '/api/services/x/pitr/restore').ok).toBe(false);
  });
});
