import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupsDir } from '../src/backup/backup.ts';
import { drillBackup } from '../src/backup/drill.ts';
import { initDb } from '../src/db/index.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Proving a backup restores.
 *
 * The point of this feature is catching the archive that looks fine and is not, so
 * the tests build exactly those: a dump cut short before its end marker, a stored
 * folder that is empty, a manifest naming a file that was never written. Each one is
 * a real way a backup fails quietly, and each must be caught.
 */

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'derailed-drill-test-'));
  initDb(join(work, 'test.db'));
  loadSecretKey(join(work, 'secret.key'));
  await mkdir(backupsDir(), { recursive: true });
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const COMPLETE_POSTGRES = `--
-- PostgreSQL database dump
--
CREATE TABLE things (id integer);
INSERT INTO things VALUES (1);
--
-- PostgreSQL database dump complete
--
`;

/** Builds a real .tar.gz in the backups folder, the shape createBackup produces. */
async function makeArchive(
  id: string,
  contents: { manifest: unknown; files: Record<string, string> },
): Promise<void> {
  const staging = join(work, `staging-${id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  await writeFile(join(staging, 'manifest.json'), JSON.stringify(contents.manifest, null, 2));
  for (const [path, body] of Object.entries(contents.files)) {
    const full = join(staging, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }

  const archive = join(backupsDir(), `${id}.tar.gz`);
  const proc = Bun.spawn(['tar', '-czf', archive, '-C', staging, '.'], { stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error('could not build the test archive');
}

function manifestFor(databases: unknown[] = [], volumes: unknown[] = []) {
  return {
    version: 1,
    createdAt: Date.now(),
    projectName: 'Shop',
    projectSlug: 'shop',
    databases,
    volumes,
  };
}

describe('a backup that is fine', () => {
  test('passes, and says what it checked', async () => {
    await makeArchive('good', {
      manifest: manifestFor(
        [{ service: 'db', engine: 'postgres', version: '16', file: 'databases/db.sql' }],
        [{ service: 'web', path: '/data', file: 'volumes/web.tar' }],
      ),
      files: {
        'databases/db.sql': COMPLETE_POSTGRES,
        'volumes/web.tar': 'not really a tar, but not empty either',
      },
    });

    const result = await drillBackup('good');
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.summary).toContain('restores');
  });

  test('passes when there is nothing inside it to check', async () => {
    await makeArchive('empty', { manifest: manifestFor(), files: {} });
    const result = await drillBackup('empty');
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });
});

describe('a backup that is not fine', () => {
  test('catches a database dump that was cut short', async () => {
    // The failure this whole feature exists for: the dump died part way, the file
    // looks plausible, and nobody finds out until they try to restore it.
    await makeArchive('truncated', {
      manifest: manifestFor([
        { service: 'db', engine: 'postgres', version: '16', file: 'databases/db.sql' },
      ]),
      files: {
        'databases/db.sql': COMPLETE_POSTGRES.slice(0, 80),
      },
    });

    const result = await drillBackup('truncated');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('cut short');
  });

  test('catches an empty dump', async () => {
    await makeArchive('empty-dump', {
      manifest: manifestFor([
        { service: 'db', engine: 'postgres', version: '16', file: 'databases/db.sql' },
      ]),
      files: { 'databases/db.sql': '' },
    });

    const result = await drillBackup('empty-dump');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('empty');
  });

  test('catches a manifest naming a file that was never written', async () => {
    await makeArchive('missing', {
      manifest: manifestFor([
        { service: 'db', engine: 'postgres', version: '16', file: 'databases/nope.sql' },
      ]),
      files: {},
    });

    const result = await drillBackup('missing');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('missing');
  });

  test('catches an empty stored folder', async () => {
    await makeArchive('empty-volume', {
      manifest: manifestFor([], [{ service: 'web', path: '/data', file: 'volumes/web.tar' }]),
      files: { 'volumes/web.tar': '' },
    });

    const result = await drillBackup('empty-volume');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('empty');
  });

  test('says so when the archive itself cannot be opened', async () => {
    await writeFile(join(backupsDir(), 'corrupt.tar.gz'), 'this is not a gzip stream');
    const result = await drillBackup('corrupt');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('could not be read back');
  });

  test('says so when there is no such backup', async () => {
    const result = await drillBackup('never-existed');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no longer on this server');
  });
});

describe('a backup that is lying about where its files are', () => {
  test('refuses to follow a path out of the archive', async () => {
    // The manifest is data read off disk, so it is untrusted. Without the guard this
    // would stat a file outside the throwaway folder and report on it.
    await makeArchive('escaping', {
      manifest: manifestFor([
        { service: 'db', engine: 'postgres', version: '16', file: '../../../../etc/passwd' },
      ]),
      files: {},
    });

    const result = await drillBackup('escaping');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('outside the backup');
  });
});

describe('engines whose dumps have no end marker', () => {
  test('are checked for being there and not empty, and no more than that', async () => {
    // Claiming a Redis snapshot is "complete" when there is no marker to look for
    // would be a lie, so this asserts the honest behaviour rather than a stricter one.
    await makeArchive('mongo', {
      manifest: manifestFor([
        { service: 'cache', engine: 'redis', version: '7', file: 'databases/dump.rdb' },
      ]),
      files: { 'databases/dump.rdb': 'REDIS0011 binary-ish contents' },
    });

    const result = await drillBackup('mongo');
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });
});
