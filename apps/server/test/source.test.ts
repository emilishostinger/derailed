import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadDir } from '../src/build/upload.ts';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Edit a file, and it's live.
 *
 * The joints worth testing: the editor is confined to the uploaded folder (a path
 * that climbs out is refused), it refuses what it cannot honestly edit (binaries,
 * repository apps), and a save can create a file that never existed, because that
 * is how a 404 page begins.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-source-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let uploadId: string;
let repoId: string;

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const project = createProject('Editable');
  uploadId = createAppService({
    projectId: project.id,
    name: 'Site',
    source: 'upload',
    repoUrl: null,
    branch: null,
  }).id;
  repoId = createAppService({
    projectId: project.id,
    name: 'FromGit',
    repoUrl: 'https://github.com/example/site',
    branch: 'main',
  }).id;

  const files = uploadDir(uploadId);
  mkdirSync(join(files, 'css'), { recursive: true });
  writeFileSync(join(files, 'index.html'), '<h1>hello</h1>\n');
  writeFileSync(join(files, 'css', 'style.css'), 'body { color: red }\n');
  writeFileSync(join(files, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
});

function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

describe('reading the site', () => {
  test('lists every file with its path, folders folded in', async () => {
    const response = await call('GET', `/api/services/${uploadId}/source`);
    expect(response.status).toBe(200);
    const { files } = (await response.json()) as { files: { path: string }[] };
    const paths = files.map((file) => file.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('css/style.css');
  });

  test('reads one file', async () => {
    const response = await call(
      'GET',
      `/api/services/${uploadId}/source/read?path=${encodeURIComponent('css/style.css')}`,
    );
    const body = (await response.json()) as { contents: string };
    expect(body.contents).toContain('color: red');
  });

  test('refuses a binary honestly', async () => {
    const response = await call('GET', `/api/services/${uploadId}/source/read?path=logo.png`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not a text file');
  });

  test('refuses a path that climbs out of the site', async () => {
    const response = await call(
      'GET',
      `/api/services/${uploadId}/source/read?path=${encodeURIComponent('../../secret.key')}`,
    );
    expect(response.status).toBe(400);
  });
});

describe('writing the site', () => {
  test('saves without deploying when asked to hold', async () => {
    const response = await call('PUT', `/api/services/${uploadId}/source`, {
      path: 'index.html',
      contents: '<h1>edited</h1>\n',
      deploy: false,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deployment: unknown };
    expect(body.deployment).toBeNull();
    expect(await readFile(join(uploadDir(uploadId), 'index.html'), 'utf8')).toBe(
      '<h1>edited</h1>\n',
    );
  });

  test('a new file is welcome; that is how a 404 page begins', async () => {
    const template = await call('GET', `/api/services/${uploadId}/source/error-page/404`);
    const { contents } = (await template.json()) as { contents: string };
    expect(contents).toContain('Page not found');

    const saved = await call('PUT', `/api/services/${uploadId}/source`, {
      path: '404.html',
      contents,
      deploy: false,
    });
    expect(saved.status).toBe(200);
    expect(await readFile(join(uploadDir(uploadId), '404.html'), 'utf8')).toContain(
      'Page not found',
    );
  });

  test('a write that climbs out of the site is refused', async () => {
    const response = await call('PUT', `/api/services/${uploadId}/source`, {
      path: '../escape.txt',
      contents: 'nope',
      deploy: false,
    });
    expect(response.status).toBe(400);
  });
});

describe('who gets an editor', () => {
  test('a repository app is refused with the reason', async () => {
    const response = await call('GET', `/api/services/${repoId}/source`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { hint?: string } };
    expect(body.error.hint).toContain('repository');
  });
});
