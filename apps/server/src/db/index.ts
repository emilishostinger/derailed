import { Database } from 'bun:sqlite';
import { paths } from '../config.ts';
import { migrations } from './schema.ts';

let database: Database | null = null;

export function openDb(file: string = paths.db): Database {
  const db = new Database(file, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);

  const applied = new Set(
    db
      .query<{ id: number }, []>('SELECT id FROM _migrations')
      .all()
      .map((r) => r.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        Date.now(),
      );
    })();
  }
}

/** The process-wide database handle. `initDb()` must run first. */
export function db(): Database {
  if (!database) throw new Error('Database not initialised, call initDb() first.');
  return database;
}

export function initDb(file?: string): Database {
  database = openDb(file);
  return database;
}

export function closeDb(): void {
  database?.close();
  database = null;
}
