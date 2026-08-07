/**
 * The query box, against a real PostgreSQL, trying to write.
 *
 * `browse.test.ts` asks `isReadOnly` what it thinks of a string, which is worth doing
 * and proves nothing about the database. This one runs the statements. It exists
 * because the bug it covers passed every string-level test there was: `WITH gone AS
 * (DELETE FROM things RETURNING *) SELECT * FROM gone` opens with an allowed word,
 * contains no semicolon, and emptied a real table. Three rows before, none after.
 *
 * The guarantee is now a read-only transaction rather than a reading of the text, so
 * the only test that can confirm it is one that asks the engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runQuery } from '../src/catalog/browse-sql.ts';
import type { Session } from '../src/catalog/dbclient.ts';
import { ping } from '../src/docker/client.ts';
import {
  createContainer,
  destroyContainer,
  inspectContainer,
  startContainer,
} from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const IMAGE = 'postgres:17-alpine';
const NAME = `derailed-readonly-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'probe-password';

let session: Session;
let containerId = '';

/** How many rows are actually in the table, asked outside the code under test. */
async function rowCount(): Promise<number> {
  const result = await runQuery(session, 'SELECT count(*) AS n FROM things');
  return Number(result.rows[0]?.[0] ?? -1);
}

suite('a query that only reads, against a real engine', () => {
  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    containerId = await createContainer({
      name: NAME,
      image: IMAGE,
      env: { POSTGRES_PASSWORD: PASSWORD },
      labels: managedLabels({ role: 'build' }),
      // Not `unless-stopped`: this one is torn down at the end of the file and should
      // not come back on its own if the daemon restarts in between.
      restartPolicy: 'no',
    });
    await startContainer(containerId);

    session = {
      containerId,
      engine: 'postgres',
      user: 'postgres',
      dbName: 'postgres',
      password: PASSWORD,
      host: '127.0.0.1',
    };

    // Postgres takes a moment, and an initdb restart in between.
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await runQuery(session, 'SELECT 1').then(
        () => true,
        () => false,
      );
      if (ready) break;
      await Bun.sleep(1000);
    }

    await seed();
  }, 180_000);

  afterAll(async () => {
    if (containerId) await destroyContainer(containerId).catch(() => undefined);
  });

  /** Written through docker exec, because the code under test refuses to write. */
  async function seed(): Promise<void> {
    const proc = Bun.spawn(
      [
        'docker',
        'exec',
        '-e',
        `PGPASSWORD=${PASSWORD}`,
        containerId,
        'psql',
        '-U',
        'postgres',
        '-q',
        '-c',
        'DROP TABLE IF EXISTS things; CREATE TABLE things(id int); INSERT INTO things VALUES (1),(2),(3);',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    await proc.exited;
  }

  test('the container is up and the table is there', async () => {
    const inspected = await inspectContainer(containerId);
    expect(inspected?.State?.Running).toBe(true);
    expect(await rowCount()).toBe(3);
  });

  test('a data-modifying CTE does not empty the table', async () => {
    // The exact statement that worked before this was fixed.
    const outcome = await runQuery(
      session,
      'WITH gone AS (DELETE FROM things RETURNING *) SELECT * FROM gone',
    ).then(
      () => 'ran',
      (err: Error) => err.message,
    );

    expect(outcome).not.toBe('ran');
    // The rows are what actually matters. A refusal that still deleted them would
    // pass any check on the error alone.
    expect(await rowCount()).toBe(3);
  });

  test('nor does EXPLAIN ANALYZE, which runs what it explains', async () => {
    await runQuery(session, 'EXPLAIN ANALYZE DELETE FROM things').catch(() => undefined);
    expect(await rowCount()).toBe(3);
  });

  test('and a write the text check has no opinion about is stopped by the engine', async () => {
    // `SELECT ... INTO` creates a table and opens with an allowed word, and no rule in
    // `isReadOnly` mentions it. This is the case the read-only transaction exists for:
    // the refusal comes from PostgreSQL, not from us guessing at SQL.
    const outcome = await runQuery(session, 'SELECT * INTO stolen FROM things').then(
      () => 'ran',
      (err: Error) => err.message,
    );
    expect(outcome).not.toBe('ran');
    expect(String(outcome)).toMatch(/read-only transaction/i);

    const exists = await runQuery(
      session,
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'stolen'",
    );
    expect(Number(exists.rows[0]?.[0])).toBe(0);
  });

  test('an ordinary read still returns its rows, correctly parsed', async () => {
    // The wrapping adds statements around the query, and psql prints a tag for each
    // one. If those tags reached the CSV parser they would arrive as rows of data.
    const result = await runQuery(session, 'SELECT id, id * 2 AS doubled FROM things ORDER BY id');
    expect(result.columns).toEqual(['id', 'doubled']);
    expect(result.rows).toEqual([
      ['1', '2'],
      ['2', '4'],
      ['3', '6'],
    ]);
  });

  test('a CTE that only reads is still allowed, because that is the point of them', async () => {
    const result = await runQuery(
      session,
      'WITH doubled AS (SELECT id * 2 AS n FROM things) SELECT n FROM doubled ORDER BY n',
    );
    expect(result.rows).toEqual([['2'], ['4'], ['6']]);
  });

  test('and a query that is simply wrong still explains itself', async () => {
    const outcome = await runQuery(session, 'SELECT * FROM no_such_table').then(
      () => 'ran',
      (err: Error) => err.message,
    );
    expect(outcome).not.toBe('ran');
    expect(String(outcome)).toMatch(/no_such_table/i);
  });
});
