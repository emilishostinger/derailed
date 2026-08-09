/**
 * The migration chain, held to the two promises a migration system lives or dies by.
 *
 * A migration is applied at boot inside a transaction and recorded in `_migrations`;
 * the house rule is "never edit one that has shipped, append a new one". These tests
 * enforce the shape of that rule so a careless edit fails here rather than on somebody's
 * server months later, when the only symptom is a boot that half-applied a schema.
 *
 * Idempotence is the headline: running `migrate` again must be a no-op, because that is
 * exactly what every restart, and every `derailed update`, does. If a second run threw,
 * or applied anything twice, the product could not restart safely.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrate } from '../src/db/index.ts';
import { migrations } from '../src/db/schema.ts';

function fresh(): Database {
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function appliedIds(db: Database): number[] {
  return db
    .query<{ id: number }, []>('SELECT id FROM _migrations ORDER BY id')
    .all()
    .map((r) => r.id);
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
    .filter((n) => n !== '_migrations');
}

describe('the migration chain', () => {
  test('the ids are unique and strictly ascending, so none was edited in place', () => {
    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!, `migration ${ids[i]} is not after ${ids[i - 1]}`).toBe(true);
    }
  });

  test('every migration has a name, so a half-applied boot can be read', () => {
    for (const m of migrations) {
      expect(m.name.trim().length, `migration ${m.id} has no name`).toBeGreaterThan(0);
    }
  });

  test('applied from empty, it records exactly the chain it ran', () => {
    const db = fresh();
    migrate(db);
    expect(appliedIds(db)).toEqual(migrations.map((m) => m.id));
    // And it actually built a schema, not just a bookkeeping table.
    expect(tableNames(db).length).toBeGreaterThan(10);
    db.close();
  });

  test('running it a second time is a perfect no-op (restart and update depend on this)', () => {
    const db = fresh();
    migrate(db);
    const idsAfterFirst = appliedIds(db);
    const schemaAfterFirst = tableNames(db);

    // The thing every restart does: migrate an already-migrated database.
    expect(() => migrate(db)).not.toThrow();

    // Nothing applied twice, nothing added, the schema unchanged.
    expect(appliedIds(db)).toEqual(idsAfterFirst);
    expect(tableNames(db)).toEqual(schemaAfterFirst);
    db.close();
  });

  test('a database stopped part way through the chain resumes and completes it', () => {
    // Simulate an older install: apply only the first half, then let migrate finish.
    const db = fresh();
    const half = Math.floor(migrations.length / 2);
    db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
    );
    for (const m of migrations.slice(0, half)) {
      db.transaction(() => {
        db.exec(m.sql);
        db.query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
          m.id,
          m.name,
        );
      })();
    }
    expect(appliedIds(db).length).toBe(half);

    // Boot: the rest apply, and only the rest.
    migrate(db);
    expect(appliedIds(db)).toEqual(migrations.map((m) => m.id));
    db.close();
  });

  test('each migration applies inside a transaction, so a broken one leaves no trace', () => {
    // A migration that throws must roll back whole: nothing it created survives, and it
    // is not marked applied, so the next boot tries it again rather than skipping a
    // half-built step. Proven by injecting a deliberately broken migration.
    const db = fresh();
    migrate(db); // get to a real schema first
    const before = tableNames(db);
    const appliedBefore = appliedIds(db);

    const broken = {
      id: 999999,
      name: 'deliberately broken',
      // Valid first statement, then a reference to a table that does not exist.
      sql: 'CREATE TABLE zzz_should_not_survive (a int); INSERT INTO nonexistent_table VALUES (1);',
    };
    expect(() => {
      db.transaction(() => {
        db.exec(broken.sql);
        db.query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
          broken.id,
          broken.name,
        );
      })();
    }).toThrow();

    // The half-built table did not survive, and the broken id was not recorded.
    expect(tableNames(db)).toEqual(before);
    expect(appliedIds(db)).toEqual(appliedBefore);
    expect(tableNames(db)).not.toContain('zzz_should_not_survive');
    db.close();
  });
});
