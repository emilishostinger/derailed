/**
 * Saved queries, and the one rule that isn't obvious from the types.
 *
 * Saving under a name that already exists updates that query rather than making a second
 * one, because the way these get written is by saving the same thing four times while
 * getting it right, and four entries called "stuck orders" is worse than one that is
 * current. Everything else here is plain CRUD; this proves the de-duplication.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import {
  deleteSavedQuery,
  findSavedQuery,
  listSavedQueries,
  saveQuery,
} from '../src/db/repo/queries.ts';
import { createDatabaseService } from '../src/db/repo/services.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-savedq-'));
let serviceId = '';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const project = createProject('Queried');
  serviceId = createDatabaseService({
    projectId: project.id,
    name: 'db',
    engine: 'postgres',
    version: '16',
    dbName: 'db',
    dbUser: 'db',
    dbPassword: 'secret',
    port: 5432,
  }).id;
});

describe('saving a query', () => {
  test('a new name creates a new query', () => {
    const q = saveQuery(serviceId, 'stuck orders', 'select * from orders');
    expect(q.name).toBe('stuck orders');
    expect(findSavedQuery(q.id)?.body).toBe('select * from orders');
    expect(listSavedQueries(serviceId)).toHaveLength(1);
  });

  test('saving the same name again updates in place, it does not pile up', () => {
    const first = saveQuery(serviceId, 'stuck orders', 'v1');
    saveQuery(serviceId, 'stuck orders', 'v2');
    const final = saveQuery(serviceId, 'stuck orders', 'v3');

    const all = listSavedQueries(serviceId);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(first.id); // same row throughout
    expect(all[0]!.body).toBe('v3'); // holding the latest text
    expect(final.id).toBe(first.id);
  });

  test('a different name is a different query, even on the same service', () => {
    saveQuery(serviceId, 'stuck orders', 'a');
    saveQuery(serviceId, 'slow signups', 'b');
    expect(listSavedQueries(serviceId)).toHaveLength(2);
  });

  test('the same name on two services does not collide', () => {
    const other = createDatabaseService({
      projectId: createProject('Other').id,
      name: 'db2',
      engine: 'postgres',
      version: '16',
      dbName: 'db2',
      dbUser: 'db2',
      dbPassword: 'secret',
      port: 5432,
    }).id;

    saveQuery(serviceId, 'shared name', 'mine');
    saveQuery(other, 'shared name', 'theirs');

    expect(listSavedQueries(serviceId)).toHaveLength(1);
    expect(listSavedQueries(other)).toHaveLength(1);
    expect(listSavedQueries(serviceId)[0]!.body).toBe('mine');
    expect(listSavedQueries(other)[0]!.body).toBe('theirs');
  });
});

describe('deleting a query', () => {
  test('a deleted query is gone and the rest remain', () => {
    const doomed = saveQuery(serviceId, 'temp', 'x');
    saveQuery(serviceId, 'keep', 'y');
    deleteSavedQuery(doomed.id);
    expect(findSavedQuery(doomed.id)).toBeNull();
    expect(listSavedQueries(serviceId).map((q) => q.name)).toEqual(['keep']);
  });
});
