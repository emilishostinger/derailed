import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-auth-'));
let app: ReturnType<typeof createApp>;

const HEADERS = { 'x-requested-with': 'derailed', 'content-type': 'application/json' };

function post(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: 'POST',
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string) {
  return app.request(path, {
    headers: { 'x-requested-with': 'derailed', ...(cookie ? { cookie } : {}) },
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
});

describe('first-run setup and sign-in', () => {
  test('reports that setup has not happened yet', async () => {
    const response = await get('/api/auth/status');
    expect(await response.json()).toEqual({ setupComplete: false });
  });

  test('rejects mutations without the CSRF header', async () => {
    const response = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  test('rejects a short password with a human message', async () => {
    const response = await post('/api/auth/setup', { email: 'a@b.com', password: 'short' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('at least 8 characters');
  });

  test('creates the admin account and signs them in', async () => {
    const response = await post('/api/auth/setup', {
      email: 'Admin@Example.com',
      password: 'correct-horse',
    });
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    expect(cookie).toContain('derailed_session=');

    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string } };
    expect(body.user.email).toBe('admin@example.com');
  });

  test('refuses a second setup', async () => {
    const response = await post('/api/auth/setup', { email: 'x@y.com', password: 'another-one' });
    expect(response.status).toBe(409);
  });

  test('rejects a wrong password', async () => {
    const response = await post('/api/auth/login', {
      email: 'admin@example.com',
      password: 'nope-nope-nope',
    });
    expect(response.status).toBe(401);
  });

  test('signs in and out', async () => {
    const login = await post('/api/auth/login', {
      email: 'admin@example.com',
      password: 'correct-horse',
    });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);

    expect((await get('/api/system', cookie)).status).toBe(200);

    const logout = await post('/api/auth/logout', {}, cookie);
    expect(logout.status).toBe(200);
    expect((await get('/api/auth/me', cookie)).status).toBe(401);
  });

  test('guards the API behind a session', async () => {
    expect((await get('/api/system')).status).toBe(401);
  });

  test('rate-limits repeated failed sign-ins', async () => {
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const response = await post('/api/auth/login', {
        email: 'admin@example.com',
        password: `wrong-${i}`,
      });
      if (response.status === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(true);
  });
});
