/**
 * The template routes' contract with the run-an-image path: the list names each
 * template's bare image repository so the wizard can recognise a typed image, and
 * the installer accepts the user's tag but never a different repository. A
 * different repository wearing WordPress's env and volumes would be a different
 * program handed WordPress's database credentials.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-templates-'));
let app: ReturnType<typeof createApp>;
let cookie = '';
let projectId = '';

const HEADERS = { 'x-requested-with': 'derailed', 'content-type': 'application/json' };

function request(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const setup = await request('POST', '/api/auth/setup', {
    email: 'owner@example.com',
    password: 'a-long-enough-password',
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const made = await request('POST', '/api/projects', { name: 'Recognition' });
  projectId = ((await made.json()) as { project: { id: string } }).project.id;
});

describe('the template list', () => {
  test('names each bare image repository, tags stripped', async () => {
    const response = await request('GET', '/api/templates');
    const { templates } = (await response.json()) as {
      templates: { slug: string; imageRepo: string }[];
    };
    const bySlug = new Map(templates.map((t) => [t.slug, t.imageRepo]));
    expect(bySlug.get('wordpress')).toBe('wordpress');
    expect(bySlug.get('umami')).toBe('ghcr.io/umami-software/umami');
    for (const repo of bySlug.values()) expect(repo).not.toContain(':');
  });
});

describe('installing with an image override', () => {
  test('a different repository is refused, before anything is created', async () => {
    const response = await request('POST', `/api/projects/${projectId}/templates`, {
      slug: 'wordpress',
      image: 'nginx:1.27',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("isn't WordPress");
  });

  test("the user's tag on the right repository is honoured", async () => {
    // A no-database template, so this runs without Docker; the queued deploy
    // fails later in the background, which is not what this test is about.
    const response = await request('POST', `/api/projects/${projectId}/templates`, {
      slug: 'uptime-kuma',
      name: 'watcher',
      image: 'louislam/uptime-kuma:2',
    });
    expect(response.status).toBe(201);
    const { service } = (await response.json()) as { service: { image: string | null } };
    expect(service.image).toBe('louislam/uptime-kuma:2');
  });

  test('no override means the template’s pinned image', async () => {
    const response = await request('POST', `/api/projects/${projectId}/templates`, {
      slug: 'uptime-kuma',
      name: 'watcher-two',
    });
    expect(response.status).toBe(201);
    const { service } = (await response.json()) as { service: { image: string | null } };
    expect(service.image).toBe('louislam/uptime-kuma:1');
  });
});
