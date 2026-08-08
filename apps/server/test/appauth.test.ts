import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, db, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService } from '../src/db/repo/services.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { listAppSessions, safeReturnPath } from '../src/http/appauth.ts';
import { mayCall } from '../src/http/permissions.ts';
import { proxySecret } from '../src/http/proxytrust.ts';
import { codeFor, generateSecret } from '../src/http/totp.ts';
import { type RouteSpec, synthesizeCaddyConfig } from '../src/proxy/routes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * One login in front of any app. Everything a visitor's browser does through
 * the proxy is done here with the same headers the proxy would attach, and
 * everything the dashboard does is done with a real session. The properties
 * that matter most are negative ones: the cookie opens one app and nothing
 * else, the session list never contains the cookie, and an account taken off
 * the list is out even mid-session.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-appauth-'));
let app: ReturnType<typeof createApp>;
let cookie = '';
let photoAppId = '';
let otherAppId = '';

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse-battery' }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  await createUser(
    'grandma@example.com',
    await Bun.password.hash('roses-are-red-violets'),
    'viewer',
  );
  await createUser(
    'stranger@example.com',
    await Bun.password.hash('a-perfectly-fine-password'),
    'viewer',
  );

  const project = createProject('Household');
  photoAppId = createAppService({
    projectId: project.id,
    name: 'Photos',
    source: 'image',
    image: 'photoprism/photoprism:latest',
    repoUrl: null,
    branch: null,
  }).id;
  otherAppId = createAppService({
    projectId: project.id,
    name: 'Notes',
    source: 'image',
    image: 'example/notes:1',
    repoUrl: null,
    branch: null,
  }).id;

  // Grandma and the admin may open Photos; the stranger may not.
  db()
    .query('UPDATE services SET login_required = 1, allowed_emails = ? WHERE id IN (?, ?)')
    .run(JSON.stringify(['grandma@example.com', 'admin@example.com']), photoAppId, otherAppId);
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** A request the way the proxy would deliver it, on the app's own address. */
function viaProxy(
  serviceId: string,
  path: string,
  init: RequestInit & { appCookie?: string } = {},
) {
  const headers: Record<string, string> = {
    'x-derailed-service': serviceId,
    'x-derailed-proxy': proxySecret(),
    'x-forwarded-for': '198.51.100.10',
    'x-forwarded-proto': 'https',
    ...(init.appCookie ? { cookie: `derailed_app=${init.appCookie}` } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return app.request(path, { ...init, headers });
}

async function signIn(serviceId: string, email: string, password: string): Promise<string> {
  const answer = await viaProxy(serviceId, '/api/public/appauth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, to: '/album/1' }).toString(),
  });
  expect(answer.status).toBe(303);
  const setCookie = answer.headers.get('set-cookie') ?? '';
  return /derailed_app=([^;]+)/.exec(setCookie)?.[1] ?? '';
}

describe('the visitor at the door', () => {
  test('a request straight to the panel, forging the service, cannot reach the gate', async () => {
    // No proxy secret. The check must not wave the visitor through to a
    // protected app, and login must not become an unthrottled password oracle
    // against the dashboard accounts.
    const check = await app.request('/api/public/appauth/check', {
      headers: { 'x-derailed-service': photoAppId, 'x-forwarded-uri': '/' },
    });
    expect(check.status).toBe(403);

    const login = await app.request('/api/public/appauth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-derailed-service': photoAppId,
      },
      body: new URLSearchParams({ email: 'admin@example.com', password: 'x', to: '/' }).toString(),
    });
    expect(login.status).toBe(404);
  });

  test('the return path stays on-site even with a backslash', async () => {
    const answer = await viaProxy(
      photoAppId,
      `/api/public/appauth/login?to=${encodeURIComponent('/\\evil.example')}`,
    );
    const html = await answer.text();
    // The form's hidden return field is neutralised to the site root.
    expect(html).toContain('value="/"');
    expect(html).not.toContain('evil.example');
  });

  test('no cookie: the check sends them to the login page, remembering where they were going', async () => {
    const answer = await viaProxy(photoAppId, '/api/public/appauth/check', {
      headers: { 'x-forwarded-uri': '/album/7' },
    });
    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe(
      `/__derailed/auth/login?to=${encodeURIComponent('/album/7')}`,
    );
  });

  test('the login page names the app and asks like a page, not an API', async () => {
    const answer = await viaProxy(photoAppId, '/api/public/appauth/login?to=/album/7');
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain('Photos');
    expect(html).toContain('type="password"');
    expect(html).toContain('value="/album/7"');
  });

  test('a wrong password and an unknown email get the same sentence', async () => {
    const attempt = (email: string) =>
      viaProxy(photoAppId, '/api/public/appauth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password: 'wrong', to: '/' }).toString(),
      });
    const known = await (await attempt('grandma@example.com')).text();
    const unknown = await (await attempt('nobody@example.com')).text();
    expect(known).toContain('do not match');
    expect(unknown).toContain('do not match');
  });

  test('the right password opens the door and the cookie holds it open', async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    expect(token.length).toBeGreaterThan(30);

    const check = await viaProxy(photoAppId, '/api/public/appauth/check', { appCookie: token });
    expect(check.status).toBe(200);
    expect(check.headers.get('x-derailed-user')).toBe('grandma@example.com');
  });

  test("grandma's cookie opens the photos and nothing else", async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    const other = await viaProxy(otherAppId, '/api/public/appauth/check', { appCookie: token });
    expect(other.status).toBe(303);
  });

  test('an account that exists but is not on the list is told so, plainly', async () => {
    const answer = await viaProxy(photoAppId, '/api/public/appauth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'stranger@example.com',
        password: 'a-perfectly-fine-password',
        to: '/',
      }).toString(),
    });
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain('not on the list');
  });

  test('being taken off the list ends the visit, mid-session', async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    db()
      .query('UPDATE services SET allowed_emails = ? WHERE id = ?')
      .run(JSON.stringify(['admin@example.com']), photoAppId);
    const check = await viaProxy(photoAppId, '/api/public/appauth/check', { appCookie: token });
    expect(check.status).toBe(303);
    db()
      .query('UPDATE services SET allowed_emails = ? WHERE id = ?')
      .run(JSON.stringify(['grandma@example.com', 'admin@example.com']), photoAppId);
  });

  test('signing out is one visit to the logout path', async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    const out = await viaProxy(photoAppId, '/api/public/appauth/logout', { appCookie: token });
    expect(out.status).toBe(303);
    const check = await viaProxy(photoAppId, '/api/public/appauth/check', { appCookie: token });
    expect(check.status).toBe(303);
  });

  test('guessing is slowed down after a handful of tries', async () => {
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      const answer = await viaProxy(photoAppId, '/api/public/appauth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '203.0.113.77',
        },
        body: new URLSearchParams({
          email: 'grandma@example.com',
          password: `guess-${i}`,
          to: '/',
        }).toString(),
      });
      if (answer.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('the second factor', () => {
  test('a code is asked for, checked, and spent', async () => {
    const secret = generateSecret();
    const user = createUser(
      'careful@example.com',
      await Bun.password.hash('a-long-careful-password'),
      'member',
    );
    const { setTotpSecret, confirmTotp } = await import('../src/db/repo/users.ts');
    setTotpSecret(user.id, secret);
    confirmTotp(user.id);
    db().query('UPDATE services SET allowed_emails = NULL WHERE id = ?').run(photoAppId);

    // Password alone: the page asks for the code rather than calling it wrong.
    const first = await viaProxy(photoAppId, '/api/public/appauth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'careful@example.com',
        password: 'a-long-careful-password',
        to: '/',
      }).toString(),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('six-digit code');

    // With the code: in.
    const step = Math.floor(Date.now() / 1000 / 30);
    const code = codeFor(secret, step) ?? '';
    const second = await viaProxy(photoAppId, '/api/public/appauth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'careful@example.com',
        password: 'a-long-careful-password',
        code,
        to: '/',
      }).toString(),
    });
    expect(second.status).toBe(303);

    // The same code again: spent, exactly as it would be on the dashboard.
    const replay = await viaProxy(photoAppId, '/api/public/appauth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'careful@example.com',
        password: 'a-long-careful-password',
        code,
        to: '/',
      }).toString(),
    });
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain('already been used');
  });
});

describe('the dashboard half', () => {
  function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  test('the session list names people, never cookies', async () => {
    await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    const answer = await call('GET', `/api/services/${photoAppId}/login`);
    const body = await answer.text();
    expect(body).toContain('grandma@example.com');
    for (const session of listAppSessions(photoAppId)) {
      expect(body).not.toContain(session.token);
    }
  });

  test('ending a session signs that browser out the moment it next asks', async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    const listed = (await (await call('GET', `/api/services/${photoAppId}/login`)).json()) as {
      sessions: { id: string }[];
    };
    for (const session of listed.sessions) {
      const ended = await call(
        'DELETE',
        `/api/services/${photoAppId}/login/sessions/${session.id}`,
      );
      expect(ended.status).toBe(200);
    }
    const check = await viaProxy(photoAppId, '/api/public/appauth/check', { appCookie: token });
    expect(check.status).toBe(303);
  });

  test('turning the door off ends every session with it', async () => {
    const token = await signIn(photoAppId, 'grandma@example.com', 'roses-are-red-violets');
    await call('PUT', `/api/services/${photoAppId}/login`, { enabled: false });
    expect(listAppSessions(photoAppId).length).toBe(0);
    expect(findService(photoAppId)?.loginRequired).toBe(false);
    // With the door gone the proxy removes the forward-auth route entirely and
    // serves the app directly, so it never calls the check endpoint again. The
    // endpoint itself now fails closed for a service it cannot resolve as gated:
    // "no gate here" must never mean "serve the protected app to anyone".
    const check = await viaProxy(photoAppId, '/api/public/appauth/check', { appCookie: token });
    expect(check.status).toBe(403);
    await call('PUT', `/api/services/${photoAppId}/login`, {
      enabled: true,
      allowedEmails: ['grandma@example.com', 'admin@example.com'],
    });
  });

  test('a member may configure it; a viewer may only look', () => {
    expect(mayCall('member', 'PUT', '/api/services/x/login').ok).toBe(true);
    expect(mayCall('viewer', 'GET', '/api/services/x/login').ok).toBe(true);
    expect(mayCall('viewer', 'PUT', '/api/services/x/login').ok).toBe(false);
    expect(mayCall('viewer', 'DELETE', '/api/services/x/login/sessions/y').ok).toBe(false);
  });
});

describe('the return path', () => {
  test('stays on the same site, whatever is asked', () => {
    expect(safeReturnPath('/album/7')).toBe('/album/7');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example/')).toBe('/');
    expect(safeReturnPath('/__derailed/auth/login')).toBe('/');
    expect(safeReturnPath('')).toBe('/');
  });
});

describe('what the proxy is told', () => {
  test('a login app gets the door before its proxy, and forward-auth has the right shape', () => {
    const route: RouteSpec = {
      hostname: 'photos.example.com',
      upstream: 'd_h_photos_abc',
      port: 2342,
      https: true,
      login: { serviceId: 'svc', panelUpstream: 'host.docker.internal', panelPort: 8422 },
    };
    const text = JSON.stringify(synthesizeCaddyConfig([route], { httpPort: 80, httpsPort: 443 }));
    expect(text).toContain('/api/public/appauth/check');
    expect(text).toContain('/api/public/appauth/login');
    expect(text).toContain('"status_code":[2]');
    expect(text).toContain('X-Forwarded-Uri');
    // The door comes before the app.
    expect(text.indexOf('appauth/check')).toBeLessThan(text.indexOf('d_h_photos_abc'));
  });
});
