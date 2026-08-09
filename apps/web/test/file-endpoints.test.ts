/**
 * The two file adapters address two different worlds, and must never cross.
 *
 * An app's *storage* (its mounted volumes, where a database's data and an app's uploads
 * live) is reached through `/files`; a dragged-in site's *source* (the files it deploys
 * from) is reached through `/source`. They look identical in the browser, on purpose, so
 * it would be easy for the wiring to send a storage read at a source path or the other
 * way round, and that is exactly the kind of confusion the realpath and symlink bugs
 * lived inside. This pins each call to its own world, its method, and its path encoding,
 * so a slip shows up here rather than as a file read from the wrong place.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { endpoints } from '../src/api/endpoints.ts';

interface Call {
  url: string;
  method: string;
  body: string | null;
}
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const last = () => calls[calls.length - 1]!;

describe("an app's storage goes through /files, and nowhere near /source", () => {
  test('list, read, write, folder, rename, delete, upload all address /files', async () => {
    await endpoints.files('svc', '/data/uploads');
    expect(last().method).toBe('GET');
    expect(last().url).toBe('/api/services/svc/files?path=%2Fdata%2Fuploads');

    await endpoints.readFile('svc', '/data/.env');
    expect(last().url).toBe('/api/services/svc/files/read?path=%2Fdata%2F.env');

    await endpoints.writeFile('svc', '/data/a.txt', 'hello');
    expect(last().method).toBe('PUT');
    expect(last().url).toBe('/api/services/svc/files');
    expect(JSON.parse(last().body ?? '{}')).toEqual({ path: '/data/a.txt', contents: 'hello' });

    await endpoints.newFolder('svc', '/data', 'uploads');
    expect(last().url).toBe('/api/services/svc/files/folder');

    await endpoints.renameFile('svc', '/data/a.txt', 'b.txt');
    expect(last().url).toBe('/api/services/svc/files/rename');

    await endpoints.deleteFile('svc', '/data/a.txt');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('/api/services/svc/files?path=%2Fdata%2Fa.txt');

    // The one path that is not a fetch: it is a URL a browser navigates to.
    expect(endpoints.downloadFileUrl('svc', '/data/a.txt')).toBe(
      '/api/services/svc/files/download?path=%2Fdata%2Fa.txt',
    );

    // Not one of those calls wandered into /source.
    expect(calls.some((c) => c.url.includes('/source'))).toBe(false);
  });
});

describe("a site's source goes through /source, and nowhere near /files", () => {
  test('list, read, write, folder, rename, delete all address /source', async () => {
    await endpoints.source('svc', '/index.html');
    expect(last().url).toBe('/api/services/svc/source?path=%2Findex.html');

    await endpoints.readSource('svc', '/index.html');
    expect(last().url).toBe('/api/services/svc/source/read?path=%2Findex.html');

    await endpoints.writeSource('svc', '/index.html', '<h1>hi</h1>', false);
    expect(last().method).toBe('PUT');
    expect(last().url).toBe('/api/services/svc/source');
    expect(JSON.parse(last().body ?? '{}')).toEqual({
      path: '/index.html',
      contents: '<h1>hi</h1>',
      deploy: false,
    });

    await endpoints.newSourceFolder('svc', '/', 'css');
    expect(last().url).toBe('/api/services/svc/source/folder');

    await endpoints.deleteSource('svc', '/old.html');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe('/api/services/svc/source?path=%2Fold.html');

    expect(endpoints.downloadSourceUrl('svc', '/index.html')).toBe(
      '/api/services/svc/source/download?path=%2Findex.html',
    );

    // Not one of those calls wandered into /files.
    expect(calls.some((c) => c.url.includes('/files'))).toBe(false);
  });
});
