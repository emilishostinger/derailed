/**
 * Unpacking a zip.
 *
 * This is the path for someone who has never opened a terminal: they drag a folder in
 * and expect a website. It shelled out to `unzip` until a real server turned out not
 * to have it, so it is done in-process now and tested against real archives.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractZip } from '../src/build/zip.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

async function into(archive: string) {
  const dir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
  const result = await extractZip(join(FIXTURES, archive), dir);
  return { dir, result };
}

describe('unpacking a zip', () => {
  test('writes out a deflated archive, contents intact', async () => {
    const { dir, result } = await into('php-site.zip');
    try {
      expect(result.files).toBe(2);
      const page = await Bun.file(join(dir, 'index.php')).text();
      expect(page).toContain('DERAILED_PROOF_OK');
      expect(page).toContain('<?php');
      expect(await Bun.file(join(dir, 'style.css')).text()).toContain('font-family');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('handles stored entries and nested folders', async () => {
    const { dir, result } = await into('stored.zip');
    try {
      expect(result.files).toBe(2);
      expect(await Bun.file(join(dir, 'page.html')).text()).toContain('nested');
      expect(await Bun.file(join(dir, 'sub/deep.txt')).text()).toContain('x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to write outside the folder it was given', async () => {
    // "../escaped.txt" is how unpacking a file turns into writing one anywhere on the
    // machine. The entry is dropped; the rest of the archive still comes out.
    const { dir, result } = await into('traversal.zip');
    try {
      expect(existsSync(join(dirname(dir), 'escaped.txt'))).toBe(false);
      expect(await Bun.file(join(dir, 'ok.txt')).text()).toContain('fine');
      expect(result.files).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('says so plainly when the file is not a zip at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
    const notAZip = join(dir, 'nope.zip');
    await Bun.write(notAZip, 'this is a text file wearing a zip extension');
    try {
      expect(extractZip(notAZip, dir)).rejects.toThrow(/doesn't look like a zip/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
