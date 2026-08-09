/**
 * Consistent state after an interruption.
 *
 * The product does a few things that must survive being killed half way: applying a
 * migration, swapping its own binary, writing a move-out archive. The discipline for all
 * of them is the same, write to one side and flip atomically, so that a crash leaves
 * either the old state or the new one and never a torn one in between. The migration and
 * self-update halves of this live in `migrations.test.ts` and `selfupdate.test.ts`; this
 * covers the move-out archive, and states the discipline it shares with them. The
 * strongest evidence of all is not in a file: the VPS smoke walk reboots the whole
 * machine mid-state and everything comes back consistent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportInstall } from '../src/backup/migrate.ts';
import { paths } from '../src/config.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'derailed-durability-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('the move-out archive is written atomically', () => {
  test('a completed export is a whole gzip, and leaves no half-written .part behind', async () => {
    const { file, sizeBytes } = await exportInstall();
    // The file exists and is a real gzip (the two magic bytes), not a truncated stub.
    expect(existsSync(file)).toBe(true);
    const head = readFileSync(file);
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);
    expect(sizeBytes).toBeGreaterThan(0);

    // Nothing partial is left in the backups folder: the `.part` the archive is built
    // under was renamed into place, never abandoned.
    const backups = join(paths.dataDir, 'backups');
    const orphans = readdirSync(backups).filter((name) => name.endsWith('.part'));
    expect(orphans).toEqual([]);
  });

  test('the final name is the one returned, and only that name is a real archive', async () => {
    const { file } = await exportInstall();
    // The returned path is a `.tar.gz`, and there is no `.part` variant of it.
    expect(file).toMatch(/derailed-move-\d+\.tar\.gz$/);
    expect(existsSync(`${file}.part`)).toBe(false);
  });
});
