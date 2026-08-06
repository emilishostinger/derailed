import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { previewFile } from '../src/runtime/preview.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * What each app looks like on its tile.
 *
 * This is decoration, so almost everything about it is allowed to fail quietly. The
 * one part that is not decoration is the route that serves the files: it takes a name
 * off a URL and opens a file with it, which is exactly the shape of a path traversal
 * if nobody is looking.
 */

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'derailed-preview-'));
  initDb(join(work, 'test.db'));
  loadSecretKey(join(work, 'secret.key'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('serving a preview file', () => {
  test('refuses anything that could walk out of the folder', async () => {
    for (const name of [
      '../../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      'a/../../secret.key',
      '/etc/passwd',
      './hidden',
      'name with spaces',
      'name;rm -rf /',
      '',
    ]) {
      expect(await previewFile(name)).toBeNull();
    }
  });

  test('refuses a file extension it does not write', async () => {
    // The only two shapes this module ever creates are `<id>-icon` and `<id>-shot.png`.
    expect(await previewFile('something.json')).toBeNull();
    expect(await previewFile('something.type')).toBeNull();
    expect(await previewFile('something.sh')).toBeNull();
  });

  test('returns null for a name that is allowed but not there', async () => {
    expect(await previewFile('nothing-here')).toBeNull();
    expect(await previewFile('nothing-here.png')).toBeNull();
  });

  test('serves a file it did write, with the right type', async () => {
    const dir = join(process.env.DERAILED_DATA ?? work, 'previews');
    await Bun.write(join(dir, 'abc-shot.png'), 'pretend png');
    await writeFile(join(dir, 'abc-icon'), 'pretend ico');
    await writeFile(join(dir, 'abc-icon.type'), 'image/png; charset=binary');

    const shot = await previewFile('abc-shot.png');
    expect(shot?.type).toBe('image/png');

    const icon = await previewFile('abc-icon');
    // The stored type is used, with any parameters trimmed off it.
    expect(icon?.type).toBe('image/png');
  });
});
