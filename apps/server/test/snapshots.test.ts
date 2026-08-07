import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { snapshotAt } from '../src/backup/snapshots.ts';
import { closeDb, db, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createDatabaseService } from '../src/db/repo/services.ts';

/**
 * Copies of one database, taken often.
 *
 * The whole feature is one rule: which copy is used for a given moment. Getting it
 * wrong in the obvious direction, by picking whichever copy is nearest in time,
 * would restore a copy taken *after* the thing being undone, which contains the thing
 * being undone. That is the one outcome worse than restoring nothing, and it is what
 * "nearest" means to anybody who has not thought about it for a minute.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function aDatabase() {
  const project = createProject('Shop');
  return createDatabaseService({
    projectId: project.id,
    name: 'db',
    engine: 'postgres',
    version: '17',
    dbName: 'shop',
    dbUser: 'derailed',
    dbPassword: 'secret',
    port: 5432,
  });
}

/** Puts a copy in the table at a given moment, without needing a live database. */
function snapshotTaken(serviceId: string, at: number, id = `s${at}`) {
  db()
    .query('INSERT INTO db_snapshots (id, service_id, at, size_bytes, file) VALUES (?, ?, ?, ?, ?)')
    .run(id, serviceId, at, 100, `${id}-dump.sql`);
  return id;
}

const AM = (hour: number) => new Date(2026, 0, 2, hour).getTime();

describe('which copy is used for a moment', () => {
  test('the newest one taken at or before it', () => {
    const database = aDatabase();
    snapshotTaken(database.id, AM(1), 'one');
    snapshotTaken(database.id, AM(2), 'two');
    snapshotTaken(database.id, AM(3), 'three');

    expect(snapshotAt(database.id, AM(2))?.id).toBe('two');
    // Half past two: the two o'clock copy, not the three o'clock one.
    expect(snapshotAt(database.id, AM(2) + 30 * 60_000)?.id).toBe('two');
  });

  test('never a later one, however much closer it is in time', () => {
    // The bad thing happened at 02:55. The 03:00 copy is five minutes away and the
    // 02:00 one is fifty-five, and the 03:00 one contains the bad thing.
    const database = aDatabase();
    snapshotTaken(database.id, AM(2), 'two');
    snapshotTaken(database.id, AM(3), 'three');

    expect(snapshotAt(database.id, AM(2) + 55 * 60_000)?.id).toBe('two');
  });

  test('nothing at all when every copy is newer than the moment', () => {
    // Rather than the oldest available one, which would be a restore nobody asked
    // for to a state nobody named.
    const database = aDatabase();
    snapshotTaken(database.id, AM(3));
    expect(snapshotAt(database.id, AM(1))).toBeNull();
  });

  test('the exact copy when the moment is exactly one of them', () => {
    const database = aDatabase();
    snapshotTaken(database.id, AM(2), 'two');
    expect(snapshotAt(database.id, AM(2))?.id).toBe('two');
  });

  test('does not reach into another database', () => {
    const mine = aDatabase();
    const other = aDatabase();
    snapshotTaken(other.id, AM(2), 'theirs');
    expect(snapshotAt(mine.id, AM(3))).toBeNull();
  });
});

describe('what a copy is worth knowing about', () => {
  test('carries its moment and its size, so a list can be read', () => {
    const database = aDatabase();
    snapshotTaken(database.id, AM(2), 'two');

    const found = snapshotAt(database.id, AM(3));
    expect(found?.at).toBe(AM(2));
    expect(found?.sizeBytes).toBe(100);
    expect(found?.serviceId).toBe(database.id);
  });
});
