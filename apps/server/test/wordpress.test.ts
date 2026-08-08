import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { isWordPress, loginPluginSource } from '../src/system/wordpress.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * WordPress superpowers, at the joints that need no container: which apps count
 * as WordPress, what the sign-in door promises, and who may press which button.
 * The full walk (install, sign in, update, stage, push) runs against real
 * containers in wordpress.integration.test.ts.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-wp-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let nginxId: string;

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

  const project = createProject('WP tests');
  nginxId = createAppService({
    projectId: project.id,
    name: 'NotWordPress',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  }).id;
});

describe('which apps count', () => {
  test('the official image does, whatever its tag; nothing else does', () => {
    const project = createProject('Detect');
    const wp = createAppService({
      projectId: project.id,
      name: 'Blog',
      source: 'image',
      image: 'wordpress:php8.3-apache',
      repoUrl: null,
      branch: null,
    });
    const repo = createAppService({
      projectId: project.id,
      name: 'Code',
      repoUrl: 'https://github.com/example/site',
      branch: 'main',
    });
    expect(isWordPress(wp)).toBe(true);
    expect(isWordPress(repo)).toBe(false);
    expect(isWordPress(null)).toBe(false);
  });

  test('the buttons refuse a non-WordPress app with the reason', async () => {
    const response = await app.request(`/api/services/${nginxId}/wordpress/login`, {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not a WordPress app');
  });
});

describe('the sign-in door', () => {
  test('is single-use, expiring, and safe to delete', () => {
    const source = loginPluginSource();
    // Single-use: the transient goes before the cookie is set.
    expect(source.indexOf('delete_transient')).toBeLessThan(source.indexOf('wp_set_auth_cookie'));
    // The token is sanitised to alphanumerics before it touches anything.
    expect(source).toContain("preg_replace('/[^A-Za-z0-9]/'");
    // And the file says whose it is and that deleting it is fine.
    expect(source).toContain('Safe to delete');
  });
});

describe('who may press what', () => {
  test('push-to-live is an owner button, because it overwrites production', () => {
    expect(mayCall('member', 'POST', '/api/services/x/wordpress/staging/push').ok).toBe(false);
    expect(mayCall('owner', 'POST', '/api/services/x/wordpress/staging/push').ok).toBe(true);
  });

  test('signing in, updating and making a staging copy are a member’s', () => {
    expect(mayCall('member', 'POST', '/api/services/x/wordpress/login').ok).toBe(true);
    expect(mayCall('member', 'POST', '/api/services/x/wordpress/update').ok).toBe(true);
    expect(mayCall('member', 'POST', '/api/services/x/wordpress/staging').ok).toBe(true);
    expect(mayCall('viewer', 'POST', '/api/services/x/wordpress/login').ok).toBe(false);
  });
});
