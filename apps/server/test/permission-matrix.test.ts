/**
 * The exhaustive route-by-role permission matrix.
 *
 * Every escalation this codebase has shipped had the same shape: a route that the
 * policy table did not mention, found later by someone (or something) walking the real
 * surface as the wrong role. `permissions.ts` promises that "a new route is covered
 * the moment it exists"; this file turns that promise into a failure mode. It walks
 * the mounted Hono router, crosses every route with every role, and compares the
 * whole grid against a table checked into the repo.
 *
 * A route that is not in the table fails the suite. Not because it is necessarily
 * wrong, but because nobody has written down what it should be. Adding a route now
 * costs one line in `permission-matrix.expected.txt`, written on purpose, reviewed in
 * the same diff as the route itself.
 *
 * Three more sweeps ride on the same enumeration, because the table alone proved
 * insufficient twice:
 *  - the owner sweep asserts the policy function never turns an owner away;
 *  - the unauthenticated sweep drives the real app with no cookie and expects 401
 *    everywhere outside the deliberately public surface (a route accidentally mounted
 *    before `requireAuth` would sail past a `mayCall` unit test);
 *  - the deny sweep drives the real app as a real member and a real viewer and
 *    expects a 403 on every route the table says is not theirs (a route accidentally
 *    mounted before `enforceRole` would likewise never notice).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-matrix-'));
let app: ReturnType<typeof createApp>;
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
    const user = createUser(`${role}@matrix.test`, hash, role);
    cookies[role] = `derailed_session=${createSession(user.id).id}`;
  }
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The routes that answer without a session, on purpose. Everything mounted before
 * `requireAuth` in app.ts: form/bot/app-login sinks a visitor's browser must reach,
 * the status page, signing in itself, and the health probe. A route claimed as
 * public here but absent from app.ts's pre-auth block would fail the 401 sweep, so
 * the two files cannot quietly drift apart.
 */
function isPublic(_method: string, path: string): boolean {
  if (path === '/api/health' || path === '/status') return true;
  if (path.startsWith('/api/public/')) return true;
  if (path.startsWith('/api/auth/')) return true;
  return false;
}

/** Fill `:params` with a value that matches nothing real and offends no regex. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'x1');
}

interface Route {
  method: string;
  path: string;
}

function enumerateRoutes(): Route[] {
  const seen = new Map<string, Route>();
  for (const r of app.routes) {
    if (r.method === 'ALL') continue; // middleware and catch-alls
    if (r.path.includes('*')) continue;
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { method: r.method, path: r.path });
  }
  return [...seen.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

/** One line per route, exactly the format of permission-matrix.expected.txt. */
function describeRoute(route: Route): string {
  if (isPublic(route.method, route.path)) {
    return `${route.method} ${route.path} public`;
  }
  const target = concrete(route.path);
  const member = mayCall('member', route.method, target).ok ? 'allow' : 'deny';
  const viewer = mayCall('viewer', route.method, target).ok ? 'allow' : 'deny';
  return `${route.method} ${route.path} member=${member} viewer=${viewer}`;
}

describe('the permission matrix', () => {
  test('every mounted route has a decision written down, and it is the recorded one', () => {
    const actual = enumerateRoutes().map(describeRoute);
    const expectedFile = join(import.meta.dir, 'permission-matrix.expected.txt');
    const expected = readFileSync(expectedFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));

    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = actual.filter((line) => !expectedSet.has(line));
    const stale = expected.filter((line) => !actualSet.has(line));

    const advice =
      'The mounted routes no longer match permission-matrix.expected.txt.\n' +
      'If you added or changed a route, decide on purpose what a member and a viewer\n' +
      'may do with it, then record that decision in the table.\n' +
      (missing.length
        ? `\nMounted but not in the table (or decision changed):\n  ${missing.join('\n  ')}\n`
        : '') +
      (stale.length
        ? `\nIn the table but no longer mounted (or decision changed):\n  ${stale.join('\n  ')}\n`
        : '');

    expect(missing, advice).toEqual([]);
    expect(stale, advice).toEqual([]);
  });

  test('an owner is never turned away by the policy function', () => {
    for (const route of enumerateRoutes()) {
      if (isPublic(route.method, route.path)) continue;
      const decision = mayCall('owner', route.method, concrete(route.path));
      expect(decision.ok, `${route.method} ${route.path} refused an owner`).toBe(true);
    }
  });
});

describe('the same matrix, driven through the real app', () => {
  async function call(cookie: string | null, method: string, path: string): Promise<Response> {
    return app.request(concrete(path), {
      method,
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({}),
    });
  }

  test('without a session, everything outside the public surface answers 401', async () => {
    for (const route of enumerateRoutes()) {
      if (isPublic(route.method, route.path)) continue;
      const res = await call(null, route.method, route.path);
      expect(
        res.status,
        `${route.method} ${route.path} answered ${res.status} with no session`,
      ).toBe(401);
    }
  });

  test('a member gets a 403, not a quiet success, on every route the table denies them', async () => {
    for (const route of enumerateRoutes()) {
      if (isPublic(route.method, route.path)) continue;
      if (mayCall('member', route.method, concrete(route.path)).ok) continue;
      const res = await call(cookies.member, route.method, route.path);
      expect(res.status, `${route.method} ${route.path} answered ${res.status} to a member`).toBe(
        403,
      );
    }
  });

  test('a viewer gets a 403, not a quiet success, on every route the table denies them', async () => {
    for (const route of enumerateRoutes()) {
      if (isPublic(route.method, route.path)) continue;
      if (mayCall('viewer', route.method, concrete(route.path)).ok) continue;
      const res = await call(cookies.viewer, route.method, route.path);
      expect(res.status, `${route.method} ${route.path} answered ${res.status} to a viewer`).toBe(
        403,
      );
    }
  });
});
