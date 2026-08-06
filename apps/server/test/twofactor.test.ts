import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loginLimiter, peerLimiter } from '../src/http/routes/auth.ts';
import { listAudit } from '../src/http/audit.ts';
import { codeFor } from '../src/http/totp.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Signing in with a second factor, over HTTP, the way a browser does it.
 *
 * The order is what matters. A password that is right but a code that is missing must
 * not produce a session, and it must not produce an error either: the browser needs
 * to know to ask, and "wrong password" would be a lie.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-2fa-'));
let app: ReturnType<typeof createApp>;
let cookie: string;

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  // Every test file shares one process, so by the time this one runs the sign-in
  // allowance has usually been spent by another. Failing on the limiter rather than
  // on what this file is actually checking would be a confusing way to waste an hour.
  loginLimiter.resetAll();
  peerLimiter.resetAll();

  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

function call(method: string, path: string, body?: unknown, withCookie = true) {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      ...(withCookie ? { cookie } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

let secret = '';

describe('turning it on', () => {
  test('hands back a secret and a scannable URL', async () => {
    const response = await call('POST', '/api/auth/totp/start');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { secret: string; url: string };
    secret = body.secret;
    expect(body.url).toStartWith('otpauth://totp/');
  });

  test('is not on until a code has been proved', async () => {
    // Somebody who scans a QR code and closes the tab must not be locked out.
    const login = await call(
      'POST',
      '/api/auth/login',
      { email: EMAIL, password: PASSWORD },
      false,
    );
    expect(login.status).toBe(200);
    expect(await login.json()).not.toMatchObject({ needsCode: true });
  });

  test('refuses a wrong code, and says why it might be wrong', async () => {
    const response = await call('POST', '/api/auth/totp/confirm', { code: '000000' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('clock');
  });

  test('turns on with a real code, and hands over recovery codes once', async () => {
    const code = codeFor(secret, Math.floor(Date.now() / 1000 / 30)) ?? '';
    const response = await call('POST', '/api/auth/totp/confirm', { code });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { enabled: boolean; recoveryCodes: string[] };
    expect(body.enabled).toBe(true);
    // Without these, this is a way to lock yourself out of your own server for good.
    expect(body.recoveryCodes.length).toBeGreaterThan(5);
  });
});

describe('signing in once it is on', () => {
  test('asks for the code rather than failing, when the password is right', async () => {
    const response = await call(
      'POST',
      '/api/auth/login',
      { email: EMAIL, password: PASSWORD },
      false,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needsCode: true });
    // And crucially, no session.
    expect(response.headers.get('set-cookie') ?? '').not.toContain('derailed');
  });

  test('still refuses a wrong password, without mentioning codes', async () => {
    const response = await call(
      'POST',
      '/api/auth/login',
      { email: EMAIL, password: 'wrong' },
      false,
    );
    expect(response.status).toBe(401);
    // The *message*, not the envelope: the error body has a `code` field of its own.
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').not.toContain('code');
  });

  test('refuses a right password with a wrong code', async () => {
    const response = await call(
      'POST',
      '/api/auth/login',
      { email: EMAIL, password: PASSWORD, code: '000000' },
      false,
    );
    expect(response.status).toBe(401);
  });

  test('signs in with a right password and a right code', async () => {
    const code = codeFor(secret, Math.floor(Date.now() / 1000 / 30)) ?? '';
    const response = await call(
      'POST',
      '/api/auth/login',
      { email: EMAIL, password: PASSWORD, code },
      false,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('=');
  });
});

describe('turning it off', () => {
  test('needs the password, not just a session', async () => {
    // A stolen session turning off the second factor is exactly what it is there for.
    expect((await call('DELETE', '/api/auth/totp', { password: 'wrong' })).status).toBe(401);
    expect((await call('DELETE', '/api/auth/totp', { password: PASSWORD })).status).toBe(200);
  });
});

describe('the sessions list', () => {
  test('shows this one, marked as this one', async () => {
    const response = await call('GET', '/api/auth/sessions');
    const body = (await response.json()) as { sessions: { current: boolean }[] };
    expect(body.sessions.some((session) => session.current)).toBe(true);
  });

  test('will not let somebody sign out a session that is not theirs', async () => {
    expect((await call('DELETE', '/api/auth/sessions/not-mine')).status).toBe(404);
  });
});

describe('the audit log', () => {
  test('recorded the changes, and not the reads', async () => {
    const entries = listAudit();
    expect(entries.some((entry) => entry.action.includes('POST /auth/totp/confirm'))).toBe(true);
    // A log of every page anybody looked at would bury the three lines that matter.
    expect(entries.some((entry) => entry.action.startsWith('GET'))).toBe(false);
  });

  test('says who', async () => {
    const entry = listAudit().find((item) => item.action.includes('/auth/totp'));
    expect(entry?.email).toBe(EMAIL);
  });
});
