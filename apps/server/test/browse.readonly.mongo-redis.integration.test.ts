/**
 * The query box against a real MongoDB and a real Redis, trying to write.
 *
 * The Postgres version of this test leans on the engine: every query runs inside a
 * read-only transaction, so the database itself refuses a write. Mongo and Redis have
 * no such thing, so their guard is an allowlist of reading methods and a blocklist of
 * dangerous ones, matched against the text. An allowlist that has drifted from what the
 * engine actually does is exactly how the `$out` bypass shipped: `aggregate` is a
 * reading method, and `[{$out: "stolen"}]` at the end of its pipeline writes a whole
 * collection. A string-level test cannot catch that; only running it against the engine
 * and then counting the rows can.
 *
 * So this is differential: for every write the guard refuses, the engine state is
 * checked to be unchanged (the guard's "no" and the engine's reality agree), and for
 * every read it allows, the rows come back correct (the wrapping did not corrupt them).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runKeyCommand } from '../src/catalog/browse-keys.ts';
import { runMongoQuery } from '../src/catalog/browse-mongo.ts';
import type { Session } from '../src/catalog/dbclient.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, destroyContainer, startContainer } from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const rid = () => Math.random().toString(36).slice(2, 8);

suite('a MongoDB expression that only reads, against a real engine', () => {
  const IMAGE = 'mongo:7';
  const NAME = `derailed-ro-mongo-${rid()}`;
  const PASSWORD = 'probe-password';
  let containerId = '';
  let session: Session;

  async function count(): Promise<number> {
    const r = await runMongoQuery(session, 'db.things.countDocuments({})');
    return Number(r.rows[0]?.[0] ?? -1);
  }

  async function collectionExists(name: string): Promise<boolean> {
    // Asked directly through mongosh, outside the code under test: listing collection
    // names is not one of the reading methods the guard allows, and rightly so.
    const uri = `mongodb://root:${PASSWORD}@127.0.0.1:27017/testdb?authSource=admin`;
    const proc = Bun.spawn(
      [
        'docker',
        'exec',
        containerId,
        'mongosh',
        uri,
        '--quiet',
        '--eval',
        `print(db.getCollectionNames().indexOf(${JSON.stringify(name)}) >= 0)`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().includes('true');
  }

  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    containerId = await createContainer({
      name: NAME,
      image: IMAGE,
      env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: PASSWORD },
      labels: managedLabels({ role: 'build' }),
      restartPolicy: 'no',
    });
    await startContainer(containerId);
    session = {
      containerId,
      engine: 'mongodb',
      user: 'root',
      dbName: 'testdb',
      password: PASSWORD,
      host: '127.0.0.1',
    };
    // Wait for mongod, then seed three documents through a direct mongosh, because the
    // code under test refuses to write.
    const uri = `mongodb://root:${PASSWORD}@127.0.0.1:27017/testdb?authSource=admin`;
    for (let attempt = 0; attempt < 90; attempt++) {
      const proc = Bun.spawn(
        [
          'docker',
          'exec',
          containerId,
          'mongosh',
          uri,
          '--quiet',
          '--eval',
          'db.runCommand({ping:1})',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if ((await proc.exited) === 0) break;
      await Bun.sleep(1000);
    }
    const seed = Bun.spawn(
      [
        'docker',
        'exec',
        containerId,
        'mongosh',
        uri,
        '--quiet',
        '--eval',
        'db.things.insertMany([{n:1},{n:2},{n:3}])',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    await seed.exited;
  }, 240_000);

  afterAll(async () => {
    if (containerId) await destroyContainer(containerId).catch(() => undefined);
  });

  test('the seed is there and a find reads it back', async () => {
    expect(await count()).toBe(3);
    const r = await runMongoQuery(session, 'db.things.find({})');
    expect(r.rows.length).toBe(3);
  });

  // The write forms that must be refused, and each must leave the three documents
  // exactly where they are. `$out` and `$merge` are the ones a text check has missed.
  const writes = [
    'db.things.aggregate([{$out: "stolen"}])',
    'db.things.aggregate([{$merge: {into: "stolen"}}])',
    'db.things.deleteMany({})',
    'db.things.drop()',
    'db.things.insertOne({n: 4})',
    'db.things.updateMany({}, {$set: {n: 0}})',
    'db.things.remove({})',
    'db.things["drop"]()',
    'db.things.find({$where: "sleep(1)"})',
  ];

  for (const write of writes) {
    test(`refuses, and does not run: ${write}`, async () => {
      const outcome = await runMongoQuery(session, write).then(
        () => 'ran',
        (err: Error) => err.message,
      );
      expect(outcome, `${write} was allowed to run`).not.toBe('ran');
      // The engine reality: nothing moved.
      expect(await count(), `${write} changed the row count`).toBe(3);
    });
  }

  test('the $out bypass left no stolen collection behind', async () => {
    expect(await collectionExists('stolen')).toBe(false);
  });

  test('an honest read still returns its rows', async () => {
    const r = await runMongoQuery(session, 'db.things.find({}).sort({n: 1})');
    expect(r.rows.length).toBe(3);
  });
});

suite('a Redis command that only reads, against a real engine', () => {
  const IMAGE = 'redis:7-alpine';
  const NAME = `derailed-ro-redis-${rid()}`;
  const PASSWORD = 'probe-password';
  let containerId = '';
  let session: Session;

  async function get(key: string): Promise<string> {
    const r = await runKeyCommand(session, `GET ${key}`);
    return String(r.rows[0]?.[0] ?? '');
  }

  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    containerId = await createContainer({
      name: NAME,
      image: IMAGE,
      cmd: ['redis-server', '--requirepass', PASSWORD],
      labels: managedLabels({ role: 'build' }),
      restartPolicy: 'no',
    });
    await startContainer(containerId);
    session = {
      containerId,
      engine: 'redis',
      user: '',
      dbName: '0',
      password: PASSWORD,
      host: '127.0.0.1',
    };
    // Wait for redis, then seed a key directly (the code under test refuses to write).
    for (let attempt = 0; attempt < 60; attempt++) {
      const proc = Bun.spawn(
        ['docker', 'exec', '-e', `REDISCLI_AUTH=${PASSWORD}`, containerId, 'redis-cli', 'ping'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if ((await proc.exited) === 0) break;
      await Bun.sleep(500);
    }
    const seed = Bun.spawn(
      [
        'docker',
        'exec',
        '-e',
        `REDISCLI_AUTH=${PASSWORD}`,
        containerId,
        'redis-cli',
        'set',
        'keep',
        'me',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    await seed.exited;
  }, 120_000);

  afterAll(async () => {
    if (containerId) await destroyContainer(containerId).catch(() => undefined);
  });

  test('the seeded key reads back', async () => {
    expect(await get('keep')).toBe('me');
  });

  const writes = [
    'SET keep hijacked',
    'DEL keep',
    'FLUSHALL',
    'FLUSHDB',
    'EXPIRE keep 1',
    'RENAME keep gone',
    'HSET h f v',
    'APPEND keep x',
  ];

  for (const write of writes) {
    test(`refuses, and does not run: ${write}`, async () => {
      const outcome = await runKeyCommand(session, write).then(
        () => 'ran',
        (err: Error) => err.message,
      );
      expect(outcome, `${write} was allowed to run`).not.toBe('ran');
      // The key is exactly as seeded: not overwritten, not deleted, not expired.
      expect(await get('keep'), `${write} changed the key`).toBe('me');
    });
  }

  test('an honest GET still returns the value', async () => {
    expect(await get('keep')).toBe('me');
  });
});
