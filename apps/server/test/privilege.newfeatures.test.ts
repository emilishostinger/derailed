/**
 * The boundary the roles are supposed to be, for every endpoint added recently.
 *
 * Driven through the real HTTP app as a member and a viewer, because the escalations
 * that have actually shipped in this codebase were invisible in the policy table and
 * obvious the moment a real member account called the real route. Every new surface
 * (the site editor, images, WordPress, the review queue, the scan, ssh, dns) is
 * probed here so the next one added is checked before it is trusted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-privilege2-'));
let app: ReturnType<typeof createApp>;
let projectId = '';
let appId = '';
const cookies: Record<'owner' | 'member' | 'viewer', string> = {
  owner: '',
  member: '',
  viewer: '',
};

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const hash = await Bun.password.hash('correct-horse');
  for (const role of ['owner', 'member', 'viewer'] as const) {
    const user = createUser(`${role}@example.com`, hash, role);
    cookies[role] = `derailed_session=${createSession(user.id).id}`;
  }
  const project = createProject('Priv');
  projectId = project.id;
  appId = createAppService({
    projectId,
    name: 'web',
    source: 'image',
    image: 'wordpress:php8.3-apache',
    repoUrl: null,
    branch: null,
    port: 80,
  }).id;
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

function call(who: 'owner' | 'member' | 'viewer', method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      cookie: cookies[who],
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

/** A viewer must never reach a write, and a 403 is the only acceptable answer. */
async function forbiddenToViewer(method: string, path: string) {
  expect((await call('viewer', method, path)).status).toBe(403);
}

describe('the security scan', () => {
  test('a viewer cannot read the report (it is a map to the secrets)', async () => {
    expect((await call('viewer', 'GET', '/api/system/scan')).status).toBe(403);
  });
  test('a member can read it but cannot run one (running clones repos, an owner act)', async () => {
    // Reading is fine; the last run may be null, but the answer must not be 403.
    expect((await call('member', 'GET', '/api/system/scan')).status).not.toBe(403);
    expect((await call('member', 'POST', '/api/system/scan')).status).toBe(403);
    await forbiddenToViewer('POST', '/api/system/scan');
  });
});

describe('ssh keys and the toggle', () => {
  test('only an owner can change keys or the password-login switch', async () => {
    await forbiddenToViewer('POST', '/api/system/ssh/keys');
    await forbiddenToViewer('PUT', '/api/system/ssh/password-login');
    expect((await call('member', 'POST', '/api/system/ssh/keys', { key: 'x' })).status).toBe(403);
    expect(
      (await call('member', 'PUT', '/api/system/ssh/password-login', { enabled: false })).status,
    ).toBe(403);
    expect((await call('member', 'DELETE', '/api/system/ssh/keys?fingerprint=x')).status).toBe(403);
  });
  test('the door keys are not shown to a viewer', async () => {
    // Which keys open the machine, and whether passwords are still on, is a hardening
    // map a look-but-not-touch guest should not be handed.
    expect((await call('viewer', 'GET', '/api/system/ssh')).status).toBe(403);
  });
});

describe('cloudflare dns', () => {
  test('only an owner holds or uses the token', async () => {
    expect((await call('member', 'PUT', '/api/system/dns', { token: 'x' })).status).toBe(403);
    expect(
      (await call('member', 'POST', '/api/system/dns/write', { hostname: 'x.com' })).status,
    ).toBe(403);
    await forbiddenToViewer('PUT', '/api/system/dns');
    await forbiddenToViewer('POST', '/api/system/dns/write');
  });
});

describe('the site editor', () => {
  test('a viewer cannot write, rename, delete, upload or make a folder', async () => {
    await forbiddenToViewer('PUT', `/api/services/${appId}/source`);
    await forbiddenToViewer('POST', `/api/services/${appId}/source/folder`);
    await forbiddenToViewer('POST', `/api/services/${appId}/source/rename`);
    await forbiddenToViewer('DELETE', `/api/services/${appId}/source`);
    await forbiddenToViewer('POST', `/api/services/${appId}/source/upload`);
  });
});

describe('images', () => {
  test('a viewer cannot toggle resizing', async () => {
    await forbiddenToViewer('PUT', `/api/services/${appId}/images`);
  });
});

describe('wordpress superpowers', () => {
  test('a viewer cannot mint a sign-in link, update, or make/push staging', async () => {
    await forbiddenToViewer('POST', `/api/services/${appId}/wordpress/login`);
    await forbiddenToViewer('POST', `/api/services/${appId}/wordpress/update`);
    await forbiddenToViewer('POST', `/api/services/${appId}/wordpress/staging`);
    await forbiddenToViewer('POST', `/api/services/${appId}/wordpress/staging/push`);
  });
  test('push-to-live is owner-only, because it overwrites production', async () => {
    // A member may make a staging copy and update; but push writes staging over live,
    // which is a restore, and restores are an owner's.
    expect(
      (await call('member', 'POST', `/api/services/${appId}/wordpress/staging/push`)).status,
    ).toBe(403);
  });
});

describe('shared project variables', () => {
  test('a viewer cannot read them (they are the side door to the same secrets)', async () => {
    // The per-app variables are fenced off for viewers already; the project's shared
    // variables come back decrypted through their own route, and are where the database
    // password and the API key every app leans on actually live.
    expect((await call('viewer', 'GET', `/api/projects/${projectId}/env`)).status).toBe(403);
    // A member may read them, because a member already holds them.
    expect((await call('member', 'GET', `/api/projects/${projectId}/env`)).status).not.toBe(403);
  });
});

describe('the review queue', () => {
  test('a viewer cannot turn review on, apply, or discard', async () => {
    await forbiddenToViewer('PUT', `/api/projects/${projectId}/review`);
    await forbiddenToViewer('POST', `/api/projects/${projectId}/pending/apply`);
    await forbiddenToViewer('DELETE', `/api/projects/${projectId}/pending`);
  });
});
