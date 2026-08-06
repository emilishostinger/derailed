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

  test('rebuilding the deployments table keeps every row', () => {
    // Migration 10 widens the trigger column, which SQLite can only do by copying the
    // table. A copy that drops rows would silently erase everyone's deploy history,
    // and the copy is written out column by column, so a column added in the wrong
    // order would shift every value one place along.
    const upto = migrations.findIndex((m) => m.id === 10);
    expect(upto).toBeGreaterThan(0);

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
    const before = ['manual', 'redeploy', 'rollback', 'webhook'].map((trigger, n) => ({
      id: `d${n}`,
      trigger,
      sha: `sha${n}`,
      message: `commit ${n}`,
      created: 1000 + n,
    }));
    for (const row of before) {
      db.query(
        `INSERT INTO deployments
           (id, service_id, status, commit_sha, commit_message, trigger, image_tag, created_at)
         VALUES (?, 's1', 'running', ?, ?, ?, ?, ?)`,
      ).run(row.id, row.sha, row.message, row.trigger, `img${row.id}`, row.created);
    }

    migrate(db);

    const after = db
      .query<
        {
          id: string;
          trigger: string;
          commit_sha: string;
          commit_message: string;
          created_at: number;
          image_tag: string;
        },
        []
      >('SELECT * FROM deployments ORDER BY created_at')
      .all();
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.trigger)).toEqual(before.map((r) => r.trigger));
    // Every value landed in its own column rather than one along.
    expect(after.map((r) => r.commit_sha)).toEqual(before.map((r) => r.sha));
    expect(after.map((r) => r.commit_message)).toEqual(before.map((r) => r.message));
    expect(after.map((r) => r.image_tag)).toEqual(before.map((r) => `img${r.id}`));

    // The new value is accepted and the old ones still are.
    expect(() =>
      db
        .query(
          `INSERT INTO deployments (id, service_id, status, trigger, created_at)
           VALUES ('d9', 's1', 'queued', 'release', 2000)`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .query(
          `INSERT INTO deployments (id, service_id, status, trigger, created_at)
           VALUES ('d10', 's1', 'queued', 'nonsense', 2001)`,
        )
        .run(),
    ).toThrow();

    // And the cascade survived the rebuild.
    db.query('DELETE FROM services WHERE id = ?').run('s1');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM deployments').get()!.n).toBe(0);
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
