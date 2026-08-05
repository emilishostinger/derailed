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
import { deflateRawSync } from 'node:zlib';
import { FriendlyError } from '../src/build/git.ts';
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

/**
 * A zip says how big each file will be once unpacked, and for a while that is the
 * number the size limit was checked against. An archive can simply lie: this one
 * declares nought bytes and inflates to 600 MB. Built here rather than committed
 * because the interesting part is the shape of the lie, not the bytes.
 */
function lyingArchive(payloadMb: number, declaredSize = 0): Buffer {
  const compressed = deflateRawSync(Buffer.alloc(payloadMb * 1024 * 1024, 0x41), { level: 9 });
  const name = Buffer.from('bomb.txt');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  const body = Buffer.concat([local, name, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const directory = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, end]);
}

describe('a zip that lies about its size', () => {
  test('refuses an entry that inflates past the ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
    const archive = join(dir, 'bomb.zip');
    await Bun.write(archive, lyingArchive(600));
    const out = join(dir, 'out');
    try {
      // 600 KB in. Before the ceiling existed this wrote 600 MB to disk and took
      // most of a gigabyte of memory doing it, while reporting a total of zero.
      await expect(extractZip(archive, out)).rejects.toThrow(/more than Derailed accepts/i);
      expect(existsSync(join(out, 'bomb.txt'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('counts what really came out, not what the archive claimed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
    const archive = join(dir, 'small.zip');
    await Bun.write(archive, lyingArchive(1));
    const out = join(dir, 'out');
    try {
      const result = await extractZip(archive, out);
      expect(result.bytes).toBe(1024 * 1024);
      expect((await Bun.file(join(out, 'bomb.txt')).stat()).size).toBe(1024 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a local header offset pointing off the end is a damaged file, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'derailed-zip-'));
    const bytes = lyingArchive(1);
    // Point the central directory entry's local header offset into the weeds.
    const centralAt = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0xfffffff0, centralAt + 42);
    const archive = join(dir, 'broken.zip');
    await Bun.write(archive, bytes);
    try {
      // A FriendlyError, so the user meets "that file looks damaged" rather than the
      // RangeError-turned-500 that an unchecked offset used to produce.
      await expect(extractZip(archive, join(dir, 'out'))).rejects.toThrow(FriendlyError);
      await expect(extractZip(archive, join(dir, 'out'))).rejects.toThrow(
        /couldn't read that zip/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
