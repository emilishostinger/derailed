/**
 * A folder dragged in as it sits on somebody's disk.
 *
 * Every path here came from a browser, which makes it a request rather than an
 * instruction. The interesting tests are the ones where the path is trying to go
 * somewhere it should not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSkipped, safeRelativePath, storeFolder, uploadDir } from '../src/build/upload.ts';
import { initDb } from '../src/db/index.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'derailed-folder-'));
  process.env.DERAILED_DATA = dir;
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (body: string) => new File([body], 'ignored');

describe('where a dropped path is allowed to land', () => {
  test('ordinary paths survive', () => {
    expect(safeRelativePath('server.js')).toBe('server.js');
    expect(safeRelativePath('src/app/main.py')).toBe('src/app/main.py');
    expect(safeRelativePath('./a/./b.txt')).toBe('a/b.txt');
    // Windows separators, because somebody will drag a folder from one.
    expect(safeRelativePath('src\\\\app\\\\main.py')).toBe('src/app/main.py');
  });

  test('anything trying to climb out is refused', () => {
    for (const attempt of [
      '../escape.js',
      'a/../../escape.js',
      '../../../../etc/cron.d/thing',
      '..',
      '',
      'a/\0b',
    ]) {
      expect(safeRelativePath(attempt)).toBeNull();
    }
  });

  test('a leading slash is made relative rather than refused', () => {
    // Not a hole: the result is still resolved inside this app's own upload folder,
    // so an absolute-looking path lands at the top of it and nowhere else.
    expect(safeRelativePath('/src/main.py')).toBe('src/main.py');
    expect(safeRelativePath('/etc/passwd')).toBe('etc/passwd');
  });
});

describe('what gets skipped', () => {
  test('other people`s build output, at any depth', () => {
    expect(isSkipped('node_modules/left-pad/index.js')).toBe(true);
    expect(isSkipped('api/.venv/lib/python3.12/site.py')).toBe(true);
    expect(isSkipped('.git/config')).toBe(true);
    expect(isSkipped('web/dist/bundle.js')).toBe(true);
  });

  test('but not source that merely looks like it', () => {
    expect(isSkipped('src/server.js')).toBe(false);
    expect(isSkipped('app/models/build_order.py')).toBe(false);
  });
});

describe('storing one', () => {
  test('writes the tree, and skips what should not travel', async () => {
    const { files } = await storeFolder('svc-tree', [
      { path: 'package.json', file: file('{}') },
      { path: 'server.js', file: file('listen()') },
      { path: 'src/lib/util.js', file: file('export {}') },
      { path: 'node_modules/left-pad/index.js', file: file('nope') },
      { path: '.git/config', file: file('nope') },
    ]);

    expect(files).toBe(3);
    const root = uploadDir('svc-tree');
    expect((await readdir(root)).sort()).toEqual(['package.json', 'server.js', 'src']);
    expect(await Bun.file(join(root, 'src/lib/util.js')).text()).toBe('export {}');
    // The skipped ones are not merely empty, they are absent.
    expect(await stat(join(root, 'node_modules')).catch(() => null)).toBeNull();
  });

  test('a path that tries to escape writes nothing outside the folder', async () => {
    await storeFolder('svc-escape', [
      { path: 'index.html', file: file('<h1>hi</h1>') },
      { path: '../../../../tmp/derailed-escaped.txt', file: file('should never exist') },
    ]);

    const root = uploadDir('svc-escape');
    expect((await readdir(root)).sort()).toEqual(['index.html']);
    expect(await Bun.file('/tmp/derailed-escaped.txt').exists()).toBe(false);
  });

  test('unwraps the folder somebody dragged, rather than nesting it', async () => {
    // Dropping `my-site` means its contents, not a folder called `my-site` with the
    // contents inside. Deploying the wrapper finds nothing to build.
    const { files } = await storeFolder('svc-wrap', [
      { path: 'my-site/index.html', file: file('<h1>hi</h1>') },
      { path: 'my-site/style.css', file: file('body{}') },
    ]);
    expect(files).toBe(2);
    expect((await readdir(uploadDir('svc-wrap'))).sort()).toEqual(['index.html', 'style.css']);
  });

  test('a folder with nothing usable in it says so', async () => {
    await expect(
      storeFolder('svc-empty', [{ path: 'node_modules/a/b.js', file: file('x') }]),
    ).rejects.toThrow(/nothing in it/);
  });
});
