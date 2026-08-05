import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrate } from '../src/db/index.ts';
import { migrations } from '../src/db/schema.ts';

function fresh(): Database {
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

describe('migrations', () => {
  test('apply cleanly to an empty database', () => {
    const db = fresh();
    migrate(db);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const table of ['users', 'sessions', 'projects', 'services', 'deployments', 'domains']) {
      expect(tables).toContain(table);
    }
  });

  test('are idempotent', () => {
    const db = fresh();
    migrate(db);
    migrate(db);
    const applied = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM _migrations').get()!.n;
    expect(applied).toBe(migrations.length);
  });

  test('apply from every intermediate version', () => {
    // Simulates an older install: apply a prefix, then let migrate() finish the job.
    for (let upto = 0; upto < migrations.length; upto++) {
      const db = fresh();
      db.exec(
        'CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
      );
      for (const migration of migrations.slice(0, upto)) {
        db.exec(migration.sql);
        db.query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
          migration.id,
          migration.name,
          0,
        );
      }
      expect(() => migrate(db)).not.toThrow();
    }
  });

  test('have unique, ascending ids', () => {
    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  test('cascade deletes from project to service to deployment', () => {
    const db = fresh();
    migrate(db);
    db.query('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'Test',
      'test',
      1,
    );
    db.query(
      `INSERT INTO services (id, project_id, kind, name, slug, created_at, updated_at)
       VALUES (?, ?, 'app', 'Web', 'web', 1, 1)`,
    ).run('s1', 'p1');
    db.query(
      `INSERT INTO deployments (id, service_id, status, created_at) VALUES (?, ?, 'queued', 1)`,
    ).run('d1', 's1');

    db.query('DELETE FROM projects WHERE id = ?').run('p1');

    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM services').get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM deployments').get()!.n).toBe(0);
  });
});
