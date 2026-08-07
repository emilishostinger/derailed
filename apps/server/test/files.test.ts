import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { tarHeader, tarLength } from '../src/docker/archive.ts';
import { resolveInsideStorage, storageRoots, validName } from '../src/runtime/files.ts';

/**
 * Browsing an app's files.
 *
 * The whole safety of this is one function: whether a path off a URL is inside a
 * folder this app was actually given. A browser rooted anywhere else is a way to read
 * every process's environment out of the container, so these tests are the feature.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function appWithStorage(...paths: string[]) {
  const project = createProject('Shop');
  const service = createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'wordpress:php8.3-apache',
    repoUrl: null,
    branch: null,
  });
  for (const path of paths) createVolume(service.id, path);
  return service;
}

describe('what counts as inside', () => {
  test('accepts the storage folder and everything under it', () => {
    const app = appWithStorage('/var/www/html');
    for (const path of [
      '/var/www/html',
      '/var/www/html/',
      '/var/www/html/wp-content',
      '/var/www/html/wp-content/themes/mine/style.css',
      '/var/www/html/a file with spaces.txt',
    ]) {
      expect(resolveInsideStorage(app.id, path)).not.toBeNull();
    }
  });

  test('refuses everything outside it', () => {
    const app = appWithStorage('/var/www/html');
    for (const path of [
      '/etc/passwd',
      '/proc/1/environ',
      '/var/www',
      '/var/www/html-other',
      '/var/www/htmlx',
      '/',
    ]) {
      expect(resolveInsideStorage(app.id, path)).toBeNull();
    }
  });

  test('refuses any attempt to climb out', () => {
    // Rejected outright rather than resolved. Resolving is where the subtle mistakes
    // live, and nothing legitimate ever needs a `..`.
    const app = appWithStorage('/var/www/html');
    for (const path of [
      '/var/www/html/../../../etc/passwd',
      '/var/www/html/..',
      '/var/www/html/../html/ok.txt',
      '/var/www/html/wp-content/../../../../etc/shadow',
    ]) {
      expect(resolveInsideStorage(app.id, path)).toBeNull();
    }
  });

  test('refuses a relative path, and a null byte', () => {
    const app = appWithStorage('/var/www/html');
    expect(resolveInsideStorage(app.id, 'var/www/html')).toBeNull();
    expect(resolveInsideStorage(app.id, '')).toBeNull();
    expect(resolveInsideStorage(app.id, '/var/www/html/ok\0.txt')).toBeNull();
  });

  test('refuses everything when the app has no storage at all', () => {
    const app = appWithStorage();
    expect(storageRoots(app.id)).toEqual([]);
    expect(resolveInsideStorage(app.id, '/var/www/html')).toBeNull();
    expect(resolveInsideStorage(app.id, '/')).toBeNull();
  });

  test('handles several storage folders', () => {
    const app = appWithStorage('/data', '/var/www/html');
    expect(resolveInsideStorage(app.id, '/data/x')).toBe('/data/x');
    expect(resolveInsideStorage(app.id, '/var/www/html/y')).toBe('/var/www/html/y');
    expect(resolveInsideStorage(app.id, '/other')).toBeNull();
  });

  test('keeps one app out of another app storage', () => {
    const mine = appWithStorage('/data/mine');
    const theirs = appWithStorage('/data/theirs');
    expect(resolveInsideStorage(mine.id, '/data/theirs/secret')).toBeNull();
    expect(resolveInsideStorage(theirs.id, '/data/mine/secret')).toBeNull();
  });

  test('normalises a trailing slash rather than refusing it', () => {
    const app = appWithStorage('/data/');
    expect(resolveInsideStorage(app.id, '/data')).toBe('/data');
    expect(resolveInsideStorage(app.id, '/data/x/')).toBe('/data/x');
  });
});

/**
 * Uploading, renaming and creating take a name rather than a path, so a slash in one
 * is the whole attack. `resolveInsideStorage` would catch the result anyway, but this
 * is the rule that has to hold when somebody adds the next operation.
 */
describe('what counts as a name', () => {
  test('accepts the names files really have', () => {
    for (const name of ['style.css', 'a file with spaces.txt', '.htaccess', 'ünïcode.png', 'a-b_c']) {
      expect(validName(name)).toBe(name);
    }
  });

  test('trims, because a trailing space is a typo and not a filename', () => {
    expect(validName('  notes.txt  ')).toBe('notes.txt');
  });

  test('refuses anything that is a path rather than a name', () => {
    for (const name of [
      '../escape',
      'a/b',
      '/absolute',
      '.',
      '..',
      '',
      '   ',
      'null\0byte',
      'x'.repeat(101),
    ]) {
      expect(validName(name)).toBeNull();
    }
  });
});

/**
 * The tar header, which is the one piece of binary format written by hand here.
 * Getting the checksum or the size field wrong means Docker rejects the upload with
 * nothing useful to say, so it is worth pinning.
 */
describe('the tar header', () => {
  test('is one block, and says the size in octal', () => {
    const header = tarHeader('style.css', 1234);
    expect(header.length).toBe(512);
    expect(new TextDecoder().decode(header.subarray(124, 136))).toBe('00000002322\0');
    expect(header[156]).toBe(0x30);
    expect(new TextDecoder().decode(header.subarray(257, 263))).toBe('ustar\0');
  });

  test('checksums to the sum of its own bytes, with the field read as spaces', () => {
    const header = tarHeader('notes.txt', 7, { uid: 33, gid: 33 });
    const stored = Number.parseInt(
      new TextDecoder().decode(header.subarray(148, 156)).replace(/[\0 ].*$/, ''),
      8,
    );

    let sum = 0;
    for (const [index, byte] of header.entries()) {
      sum += index >= 148 && index < 156 ? 0x20 : byte;
    }
    expect(stored).toBe(sum);
  });

  test('carries the owner, so an upload is not left owned by root', () => {
    const header = tarHeader('plugin.php', 10, { uid: 33, gid: 33 });
    expect(new TextDecoder().decode(header.subarray(108, 116))).toBe('0000041\0');
    expect(new TextDecoder().decode(header.subarray(116, 124))).toBe('0000041\0');
  });

  test('refuses a name too long for the format', () => {
    expect(() => tarHeader('x'.repeat(101), 0)).toThrow();
  });

  test('pads to whole blocks, and ends with two empty ones', () => {
    expect(tarLength(0)).toBe(512 + 1024);
    expect(tarLength(1)).toBe(512 + 512 + 1024);
    expect(tarLength(512)).toBe(512 + 512 + 1024);
    expect(tarLength(513)).toBe(512 + 1024 + 1024);
  });
});
