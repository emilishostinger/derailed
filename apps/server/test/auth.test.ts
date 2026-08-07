import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loginLimiter, peerLimiter } from '../src/http/routes/auth.ts';
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
    expect(body.error.message).toContain('at least 10 characters');
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

  /**
   * The limiter used to key on `X-Forwarded-For`, which is written by whoever is
   * calling. Rotating it made every guess look like a new person, and sixty attempts
   * in a row went through without one of them being throttled.
   */
  test('a made-up X-Forwarded-For does not buy more attempts', async () => {
    // Its own peer address, so this has its own bucket and cannot be affected by the
    // attempts above or interfere with them.
    const peer = { ip: { address: '198.51.100.4', family: 'IPv4', port: 41234 } };
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const response = await app.request(
        '/api/auth/login',
        {
          method: 'POST',
          headers: { ...HEADERS, 'x-forwarded-for': `10.0.0.${i}` },
          body: JSON.stringify({ email: 'admin@example.com', password: `guess-${i}` }),
        },
        peer,
      );
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(10);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
  });

  /**
   * Behind Caddy the forwarded header has to be believed, or every visitor would be
   * one caller. That belief is worth something to whoever holds that connection: a
   * compromised app container on the same Docker bridge could rotate the header and
   * guess for ever. So attempts down one socket are capped as well, loosely.
   */
  test('a trusted proxy position does not buy unlimited attempts either', async () => {
    const peer = { ip: { address: '172.18.0.9', family: 'IPv4', port: 5555 } };
    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) {
      const response = await app.request(
        '/api/auth/login',
        {
          method: 'POST',
          headers: { ...HEADERS, 'x-forwarded-for': `203.0.113.${i}` },
          body: JSON.stringify({ email: 'admin@example.com', password: `guess-${i}` }),
        },
        peer,
      );
      statuses.push(response.status);
    }
    // Each forwarded address gets its own five, so the per-address limiter never
    // fires; the socket ceiling is the only thing standing here.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(30);
    // Forty-five password verifications, and argon2 is meant to be slow. On a loaded
    // machine that is comfortably past the default five seconds, so this failed for
    // reasons that had nothing to do with rate limiting.
  }, 60_000);

  test('the dashboard cannot be framed, and API replies are never cached', async () => {
    const response = await get('/api/auth/status');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * The sign-in route is the one endpoint on the machine that strangers are meant to
 * reach, so how it fails matters more than anywhere else.
 *
 * It reads its own body, because the second-factor code is an optional extra the
 * schema deliberately does not describe, and it used zod's `parse` to check the rest.
 * That throws a `ZodError`, which nothing upstream recognises, so *every* malformed
 * sign-in came back as "Something went wrong on the server". Found by calling every
 * route on a running server with an empty body and looking for 500s.
 */
describe('a sign-in request that is not shaped like one', () => {
  // The limiter is checked before the body is even read, and rightly so. These tests
  // are about the body, so each starts with a fresh allowance rather than measuring
  // how many of them have run.
  beforeEach(() => {
    loginLimiter.resetAll();
    peerLimiter.resetAll();
  });

  const badBodies: [string, unknown][] = [
    ['an empty object', {}],
    ['only an email', { email: 'someone@example.com' }],
    ['only a password', { password: 'correct-horse' }],
    ['numbers instead of strings', { email: 123, password: 456 }],
    ['an array', []],
    ['a bare string', 'nope'],
    ['null', null],
    ['an email that is not one', { email: 'not-an-email', password: 'correct-horse' }],
  ];

  for (const [name, body] of badBodies) {
    test(`${name} is a 400, not a 500`, async () => {
      const response = await post('/api/auth/login', body);
      expect(response.status).toBeLessThan(500);
      expect(response.status).toBe(400);

      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe('bad_request');
      // And it says which field, rather than shrugging.
      expect(error.message).toBeTruthy();
      expect(error.message).not.toContain('went wrong on the server');
    });
  }

  test('a body that is not JSON at all is a 400 too', async () => {
    const response = await app.request('/api/auth/login', {
      method: 'POST',
      headers: HEADERS,
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  test('and a well-shaped request still gets the ordinary refusal', async () => {
    // The point is to separate "you sent nonsense" from "that is the wrong password",
    // and the second must not start looking like the first.
    const response = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'a-long-enough-password',
    });
    expect(response.status).toBe(401);
  });
});
