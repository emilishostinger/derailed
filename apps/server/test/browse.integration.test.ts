/**
 * The Browse tab against real databases.
 *
 * One screen over six engines is the sort of feature that looks finished in a unit
 * test and falls over on contact with an actual client: `mysql --raw` splitting a row
 * containing a newline into six rows, `X'31'` silently matching nothing in an integer
 * column, a NULL and an empty string printing identically. Every one of those was
 * found here rather than by somebody looking at their own data.
 *
 * Four engines rather than six on purpose. MariaDB runs the MySQL path and Redis runs
 * the Valkey path, byte for byte; a fifth and sixth container would take four more
 * minutes to test the same code.
 *
 * Skipped automatically when the Docker socket isn't there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browseKeys,
  getDocument,
  getKey,
  listTables,
  putDocument,
  putKey,
  readTable,
  removeKey,
  runQuery,
  updateCell,
} from '../src/catalog/browse.ts';
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
if (!dockerAvailable) console.warn('[test] Docker socket not reachable, skipping browse tests.');

const dir = mkdtempSync(join(tmpdir(), 'derailed-browse-'));
const RUN_ID = Math.random().toString(36).slice(2, 8);

let projectId = '';
let projectSlug = '';
const made: { id: string; slug: string }[] = [];

/** A value that would end the string literal, if anything here used string literals. */
const NASTY = 'O\'Brien"); DROP TABLE people; --';

async function make(name: string, engine: string, version: string): Promise<string> {
  const service = await createDatabaseFromCatalog(projectId, name, engine, version);
  made.push({ id: service.id, slug: service.slug });
  return service.id;
}

async function waitHealthy(slug: string): Promise<void> {
  const container = await findContainerByName(containerName(projectSlug, slug));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const details = await inspectContainer(container!.Id);
    if (details?.State.Health?.Status === 'healthy') return;
    await Bun.sleep(1000);
  }
  throw new Error(`${slug} never became healthy`);
}

/** Seeds through the engine's own client, the same door the feature uses. */
async function seed(serviceId: string, cmd: string[], env: string[] = []): Promise<void> {
  const session = await openSession(serviceId);
  const { code, out } = await exec(session.containerId, cmd, env, 60_000);
  if (code !== 0) throw new Error(`seeding failed: ${out}`);
}

suite('browsing every kind of database', () => {
  beforeAll(async () => {
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    const project = createProject(`Browse ${RUN_ID}`);
    projectId = project.id;
    projectSlug = project.slug;
  }, 60_000);

  afterAll(async () => {
    for (const entry of made) {
      const container = await findContainerByName(containerName(projectSlug, entry.slug)).catch(
        () => null,
      );
      if (container) await destroyContainer(container.Id, 5).catch(() => undefined);
      await removeVolume(`derailed-v-${entry.id}`).catch(() => undefined);
      deleteService(entry.id);
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
  }, 300_000);

  describe('PostgreSQL, which keeps rows', () => {
    let id = '';

    beforeAll(async () => {
      id = await make('pgbrowse', 'postgres', '17');
      await waitHealthy('pgbrowse');
      const session = await openSession(id);
      await seed(
        id,
        [
          'psql',
          '-U',
          session.user,
          '-d',
          session.dbName,
          '-c',
          `CREATE TABLE people (id serial PRIMARY KEY, name text, note text, age int);
           INSERT INTO people (name, note, age) VALUES ('Ada', 'line one
line two	tabbed', 36), ('Grace', NULL, 45);
           CREATE TABLE keyless (a int, b int);
           INSERT INTO keyless VALUES (1, 2);
           CREATE TABLE "MixedCase" (id serial PRIMARY KEY, "Some Column" text);
           INSERT INTO "MixedCase" ("Some Column") VALUES ('kept');`,
        ],
        [`PGPASSWORD=${session.password}`],
      );
    }, 400_000);

    test('lists its tables', async () => {
      const tables = (await listTables(id)).map((t) => t.name);
      expect(tables).toContain('people');
      expect(tables).toContain('keyless');
    }, 60_000);

    test('tells a null apart from an empty string', async () => {
      const result = await readTable(id, 'people', 100, 0);
      const note = result.columns.indexOf('note');
      expect(result.rows[1]?.[note]).toBeNull();
      expect(result.rows[0]?.[note]).toContain('line two');
    }, 60_000);

    test('keeps a row containing a newline as one row', async () => {
      const result = await readTable(id, 'people', 100, 0);
      expect(result.rows).toHaveLength(2);
      expect(result.total).toBe(2);
    }, 60_000);

    test('pages, and says how many there are altogether', async () => {
      const page = await readTable(id, 'people', 1, 1);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.[page.columns.indexOf('name')]).toBe('Grace');
      expect(page.total).toBe(2);
    }, 60_000);

    test('finds the primary key, so a cell can be edited', async () => {
      const result = await readTable(id, 'people', 10, 0);
      expect(result.primaryKey).toEqual(['id']);
      expect(result.readOnly).toBe(false);
    }, 60_000);

    test('refuses to edit a table with no primary key, and says why', async () => {
      const result = await readTable(id, 'keyless', 10, 0);
      expect(result.readOnly).toBe(true);
      expect(result.readOnlyReason).toMatch(/primary key/);
      await expect(updateCell(id, 'keyless', { a: '1' }, 'b', '9')).rejects.toThrow(/primary key/);
    }, 60_000);

    test('stores a value that would otherwise end the statement', async () => {
      await updateCell(id, 'people', { id: '1' }, 'note', NASTY);
      const result = await readTable(id, 'people', 10, 0);
      expect(result.rows[0]?.[result.columns.indexOf('note')]).toBe(NASTY);

      // The proof that it was data and not a statement.
      expect((await listTables(id)).map((t) => t.name)).toContain('people');
    }, 60_000);

    test('writes a number into a number column', async () => {
      await updateCell(id, 'people', { id: '1' }, 'age', '99');
      const result = await readTable(id, 'people', 10, 0);
      expect(result.rows[0]?.[result.columns.indexOf('age')]).toBe('99');
    }, 60_000);

    test('clears a cell to null, which is not the same as clearing it to empty', async () => {
      await updateCell(id, 'people', { id: '1' }, 'note', null);
      const first = await readTable(id, 'people', 10, 0);
      expect(first.rows[0]?.[first.columns.indexOf('note')]).toBeNull();

      await updateCell(id, 'people', { id: '1' }, 'note', '');
      const second = await readTable(id, 'people', 10, 0);
      expect(second.rows[0]?.[second.columns.indexOf('note')]).toBe('');
    }, 60_000);

    test('says so rather than silently doing nothing when the row has gone', async () => {
      await expect(updateCell(id, 'people', { id: '9999' }, 'note', 'x')).rejects.toThrow(
        /no longer there/,
      );
    }, 60_000);

    test('runs a query that reads, and refuses one that does not', async () => {
      const result = await runQuery(id, 'select count(*) from people');
      expect(result.rows[0]?.[0]).toBe('2');
      await expect(runQuery(id, 'drop table people')).rejects.toThrow(
        /only runs queries that read/,
      );
      await expect(runQuery(id, 'select 1; drop table people')).rejects.toThrow(
        /only runs queries that read/,
      );
    }, 60_000);

    test('refuses a table it was never told about', async () => {
      await expect(readTable(id, 'pg_shadow', 10, 0)).rejects.toThrow(/no table called/);
    }, 60_000);

    test('handles a table and a column whose names need quoting', async () => {
      // Casting the name to `regclass` would case-fold it, so `MixedCase` would be
      // looked up as `mixedcase` and reported as not existing.
      const result = await readTable(id, 'MixedCase', 10, 0);
      expect(result.primaryKey).toEqual(['id']);
      expect(result.rows[0]?.[result.columns.indexOf('Some Column')]).toBe('kept');

      await updateCell(id, 'MixedCase', { id: '1' }, 'Some Column', 'changed');
      const after = await readTable(id, 'MixedCase', 10, 0);
      expect(after.rows[0]?.[after.columns.indexOf('Some Column')]).toBe('changed');
    }, 60_000);
  });

  describe('MySQL, which escapes its output differently', () => {
    let id = '';

    beforeAll(async () => {
      id = await make('mybrowse', 'mysql', '8.4');
      await waitHealthy('mybrowse');
      const session = await openSession(id);
      await seed(
        id,
        [
          'mysql',
          '-u',
          session.user,
          session.dbName,
          '-e',
          `CREATE TABLE people (id int AUTO_INCREMENT PRIMARY KEY, name varchar(50), note text, age int);
           INSERT INTO people (name, note, age) VALUES ('Ada', 'line one\nline two\ttabbed', 36), ('Grace', NULL, 45);`,
        ],
        [`MYSQL_PWD=${session.password}`],
      );
    }, 400_000);

    test('keeps a row containing a newline and a tab as one row', async () => {
      const result = await readTable(id, 'people', 100, 0);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]?.[result.columns.indexOf('note')]).toBe('line one\nline two\ttabbed');
    }, 60_000);

    test('tells a null apart from an empty string', async () => {
      const result = await readTable(id, 'people', 100, 0);
      expect(result.rows[1]?.[result.columns.indexOf('note')]).toBeNull();
    }, 60_000);

    test('finds the primary key and edits by it', async () => {
      const before = await readTable(id, 'people', 10, 0);
      expect(before.primaryKey).toEqual(['id']);

      await updateCell(id, 'people', { id: '1' }, 'note', NASTY);
      const after = await readTable(id, 'people', 10, 0);
      expect(after.rows[0]?.[after.columns.indexOf('note')]).toBe(NASTY);
      expect((await listTables(id)).map((t) => t.name)).toContain('people');
    }, 60_000);

    test('writes a number into a number column', async () => {
      await updateCell(id, 'people', { id: '2' }, 'age', '7');
      const result = await readTable(id, 'people', 10, 0);
      expect(result.rows[1]?.[result.columns.indexOf('age')]).toBe('7');
    }, 60_000);
  });

  describe('MongoDB, which keeps documents', () => {
    let id = '';

    beforeAll(async () => {
      id = await make('mongobrowse', 'mongodb', '8');
      await waitHealthy('mongobrowse');
      const session = await openSession(id);
      await seed(
        id,
        [
          '/bin/sh',
          '-c',
          'exec mongosh "$MONGO_URI" --quiet --eval "$0"',
          'db.users.insertMany([{ name: "Ada", age: 36, tags: ["x"] }, { name: "Grace", note: null }]); db.orders.insertOne({ total: 12.5 });',
        ],
        [
          `MONGO_URI=mongodb://${encodeURIComponent(session.user)}:${encodeURIComponent(session.password)}@127.0.0.1:27017/${session.dbName}?authSource=admin`,
        ],
      );
    }, 400_000);

    test('lists its collections with counts', async () => {
      const collections = await listTables(id);
      expect(collections.map((c) => c.name).sort()).toEqual(['orders', 'users']);
      expect(collections.find((c) => c.name === 'users')?.approximateRows).toBe(2);
    }, 60_000);

    test('flattens documents into columns without inventing values', async () => {
      const result = await readTable(id, 'users', 100, 0);
      expect(result.columns).toContain('name');
      expect(result.columns).toContain('age');
      expect(result.total).toBe(2);

      // Grace has no `age` at all, which is not the same as an age of null.
      const age = result.columns.indexOf('age');
      expect(result.rows[0]?.[age]).toBe('36');
      expect(result.rows[1]?.[age]).toBeNull();
    }, 60_000);

    test('shows an ObjectId as its id rather than as a wrapper object', async () => {
      const result = await readTable(id, 'users', 100, 0);
      const value = result.rows[0]?.[result.columns.indexOf('_id')];
      expect(value).toMatch(/^[0-9a-f]{24}$/);
    }, 60_000);

    test('opens one document as JSON and saves it back', async () => {
      const listed = await readTable(id, 'users', 100, 0);
      const documentId = listed.rows[0]?.[listed.columns.indexOf('_id')] ?? '';

      const json = await getDocument(id, 'users', documentId);
      expect(json).toContain('"Ada"');

      await putDocument(id, 'users', documentId, JSON.stringify({ name: 'Ada Lovelace', age: 36 }));
      const after = await readTable(id, 'users', 100, 0);
      expect(after.rows[0]?.[after.columns.indexOf('name')]).toBe('Ada Lovelace');
    }, 60_000);

    test('a field deleted in the editor really goes', async () => {
      const listed = await readTable(id, 'users', 100, 0);
      const documentId = listed.rows[0]?.[listed.columns.indexOf('_id')] ?? '';
      await putDocument(id, 'users', documentId, JSON.stringify({ name: 'Ada Lovelace' }));

      const json = await getDocument(id, 'users', documentId);
      expect(json).not.toContain('age');
    }, 60_000);

    test('refuses JSON that is not', async () => {
      const listed = await readTable(id, 'users', 100, 0);
      const documentId = listed.rows[0]?.[listed.columns.indexOf('_id')] ?? '';
      await expect(putDocument(id, 'users', documentId, '{ nope')).rejects.toThrow(/valid JSON/);
    }, 60_000);

    test('runs a find, and refuses anything that writes', async () => {
      const result = await runQuery(id, 'db.orders.find({})');
      expect(result.rows).toHaveLength(1);

      for (const attempt of [
        'db.users.drop()',
        'db.users.deleteMany({})',
        'db.users.find({}); db.users.drop()',
        'db.adminCommand("shutdown")',
      ]) {
        await expect(runQuery(id, attempt)).rejects.toThrow(/only runs expressions that read/);
      }
    }, 60_000);

    test('refuses a collection it was never told about', async () => {
      await expect(readTable(id, 'system.users', 10, 0)).rejects.toThrow(/no collection called/);
    }, 60_000);

    test('opens a document whose id is a number rather than an ObjectId', async () => {
      // Applications that migrated from SQL keep their old integer ids. Treating
      // every `_id` as an ObjectId means those documents cannot be opened at all.
      await seed(
        id,
        [
          '/bin/sh',
          '-c',
          'exec mongosh "$MONGO_URI" --quiet --eval "$0"',
          'db.legacy.insertOne({ _id: 7, name: "old" });',
        ],
        [
          `MONGO_URI=mongodb://${encodeURIComponent((await openSession(id)).user)}:${encodeURIComponent((await openSession(id)).password)}@127.0.0.1:27017/${(await openSession(id)).dbName}?authSource=admin`,
        ],
      );

      const json = await getDocument(id, 'legacy', '7');
      expect(json).toContain('"old"');

      await putDocument(id, 'legacy', '7', JSON.stringify({ name: 'renamed' }));
      const after = await getDocument(id, 'legacy', '7');
      expect(after).toContain('"renamed"');
    }, 60_000);
  });

  describe('Valkey, which keeps keys', () => {
    let id = '';

    beforeAll(async () => {
      id = await make('valkeybrowse', 'valkey', '8');
      await waitHealthy('valkeybrowse');
      const session = await openSession(id);
      await seed(
        id,
        [
          '/bin/sh',
          '-c',
          'valkey-cli set greeting hello && valkey-cli expire greeting 500 && valkey-cli set n 42 && valkey-cli rpush jobs a b c && valkey-cli hset user:1 name Ada age 36',
        ],
        [`REDISCLI_AUTH=${session.password}`],
      );
    }, 400_000);

    test('has no tables, which is the honest answer rather than an error', async () => {
      expect(await listTables(id)).toEqual([]);
    }, 60_000);

    test('scans keys with their type and expiry', async () => {
      const page = await browseKeys(id, '*', '0');
      const names = page.keys.map((k) => k.name).sort();
      expect(names).toEqual(['greeting', 'jobs', 'n', 'user:1']);

      const greeting = page.keys.find((k) => k.name === 'greeting');
      expect(greeting?.type).toBe('string');
      expect(greeting?.expiresIn).toBeGreaterThan(0);
      expect(page.keys.find((k) => k.name === 'n')?.expiresIn).toBeNull();
      expect(page.keys.find((k) => k.name === 'jobs')?.type).toBe('list');
    }, 60_000);

    test('filters by pattern', async () => {
      const page = await browseKeys(id, 'user:*', '0');
      expect(page.keys.map((k) => k.name)).toEqual(['user:1']);
    }, 60_000);

    test('reads a string, a list and a hash, each in its own shape', async () => {
      const string = await getKey(id, 'greeting');
      expect(string.entries).toEqual([{ field: null, value: 'hello' }]);
      expect(string.editable).toBe(true);

      const list = await getKey(id, 'jobs');
      expect(list.entries.map((e) => e.value)).toEqual(['a', 'b', 'c']);
      expect(list.editable).toBe(false);

      const hash = await getKey(id, 'user:1');
      expect(hash.entries.map((e) => e.field).sort()).toEqual(['age', 'name']);
      expect(hash.editable).toBe(false);
    }, 60_000);

    test('edits a string and keeps its expiry', async () => {
      const before = await getKey(id, 'greeting');
      await putKey(id, 'greeting', 'hello there');

      const after = await getKey(id, 'greeting');
      expect(after.entries[0]?.value).toBe('hello there');
      expect(after.expiresIn).toBeGreaterThan(0);
      expect(after.expiresIn).toBeLessThanOrEqual(before.expiresIn ?? 0);
    }, 60_000);

    test('refuses to edit anything that is not a plain string', async () => {
      await expect(putKey(id, 'jobs', 'x')).rejects.toThrow(/holds a list/);
    }, 60_000);

    test('deletes a key', async () => {
      await putKey(id, 'n', '43');
      await removeKey(id, 'n');
      await expect(getKey(id, 'n')).rejects.toThrow(/no key by that name/);
    }, 60_000);

    test('runs a command that reads, and refuses the rest', async () => {
      const result = await runQuery(id, 'hgetall user:1');
      expect(result.rows.flat()).toContain('Ada');

      for (const attempt of [
        'flushall',
        'del greeting',
        'set greeting nope',
        'keys *',
        'config set x y',
      ]) {
        await expect(runQuery(id, attempt)).rejects.toThrow(/only runs commands that read/);
      }
      // The refusals were refusals, not silent no-ops.
      expect((await getKey(id, 'greeting')).entries[0]?.value).toBe('hello there');
    }, 60_000);

    test('keeps a quoted argument together', async () => {
      await putKey(id, 'greeting', 'two words');
      const result = await runQuery(id, 'get "greeting"');
      expect(result.rows[0]?.[0]).toBe('two words');
    }, 60_000);

    test('keeps a JSON value whole rather than one line per line', async () => {
      // Half of everything in a cache is JSON, and JSON is full of newlines. Treating
      // each line as its own value shows a fragment and then saves the fragment back
      // over the whole thing.
      const json = '{\n  "user": 1,\n  "roles": ["a", "b"]\n}';
      const session = await openSession(id);
      await seed(
        id,
        ['valkey-cli', 'set', 'session:abc', json],
        [`REDISCLI_AUTH=${session.password}`],
      );

      const value = await getKey(id, 'session:abc');
      expect(value.entries).toHaveLength(1);
      expect(value.entries[0]?.value).toBe(json);

      // And it survives a save, which is the half of the bug that loses data.
      const edited = `${json}\n{"trailing": true}`;
      await putKey(id, 'session:abc', edited);
      expect((await getKey(id, 'session:abc')).entries[0]?.value).toBe(edited);
    }, 60_000);

    test('editing a key that has since gone says so', async () => {
      await expect(putKey(id, 'never-existed', 'x')).rejects.toThrow(/no key by that name/);
    }, 60_000);
  });
});
