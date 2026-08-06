import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { resolveInsideStorage, storageRoots } from '../src/runtime/files.ts';

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
