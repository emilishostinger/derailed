/**
 * Roles over real HTTP, the way a browser meets them.
 *
 * The policy has its own tests. This one exists because a correct policy wired in the
 * wrong place is indistinguishable from no policy at all: the middleware has to be
 * mounted where every route is behind it, and the routes for managing people have to
 * be behind it too.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loginLimiter, peerLimiter } from '../src/http/routes/auth.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-people-'));
let app: ReturnType<typeof createApp>;

const OWNER = { email: 'owner@example.com', password: 'correct-horse-battery' };
const MEMBER = { email: 'member@example.com', password: 'member-password-here' };
const VIEWER = { email: 'viewer@example.com', password: 'viewer-password-here' };

const cookies: Record<string, string> = {};

function call(method: string, path: string, as: string | null, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      ...(as ? { cookie: cookies[as] ?? '' } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function signIn(who: { email: string; password: string }): Promise<string> {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  loginLimiter.resetAll();
  peerLimiter.resetAll();

  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  expect(setup.status).toBe(200);
  cookies.owner = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('adding people', () => {
  test('the person who set the server up is an owner', async () => {
    const response = await call('GET', '/api/people', 'owner');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { people: { email: string; role: string }[] };
    expect(body.people).toHaveLength(1);
    expect(body.people[0]!.role).toBe('owner');
  });

  test('an owner can add a member and a viewer', async () => {
    for (const [who, role] of [
      [MEMBER, 'member'],
      [VIEWER, 'viewer'],
    ] as const) {
      const response = await call('POST', '/api/people', 'owner', { ...who, role });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { person: { role: string } };
      expect(body.person.role).toBe(role);
    }

    cookies.member = await signIn(MEMBER);
    cookies.viewer = await signIn(VIEWER);
  });

  test('the same address twice is refused, rather than making a second account', async () => {
    const response = await call('POST', '/api/people', 'owner', { ...MEMBER, role: 'viewer' });
    expect(response.status).toBe(409);
  });

  test('a short password is refused the same way it is at setup', async () => {
    const response = await call('POST', '/api/people', 'owner', {
      email: 'weak@example.com',
      password: 'short',
      role: 'viewer',
    });
    expect(response.status).toBe(400);
  });
});

describe('what a viewer meets', () => {
  test('reads are fine', async () => {
    expect((await call('GET', '/api/projects', 'viewer')).status).toBe(200);
    expect((await call('GET', '/api/system/stats', 'viewer')).status).toBe(200);
  });

  test('every change is refused, in words rather than a code', async () => {
    const response = await call('POST', '/api/projects', 'viewer', { name: 'Nope' });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('not change it');
  });

  test('and the refusal is real: nothing was created', async () => {
    const response = await call('GET', '/api/projects', 'owner');
    const body = (await response.json()) as { projects: unknown[] };
    expect(body.projects).toHaveLength(0);
  });

  test('cannot see who else is here', async () => {
    expect((await call('GET', '/api/people', 'viewer')).status).toBe(403);
  });
});

describe('what a member meets', () => {
  test('can create a project, which is the point of being a member', async () => {
    const response = await call('POST', '/api/projects', 'member', { name: 'Members Project' });
    expect(response.status).toBe(201);
  });

  test('cannot delete one', async () => {
    const list = (await (await call('GET', '/api/projects', 'member')).json()) as {
      projects: { id: string }[];
    };
    const response = await call('DELETE', `/api/projects/${list.projects[0]!.id}`, 'member');
    expect(response.status).toBe(403);

    const after = (await (await call('GET', '/api/projects', 'owner')).json()) as {
      projects: unknown[];
    };
    expect(after.projects).toHaveLength(1);
  });

  test('cannot change the server', async () => {
    expect((await call('PATCH', '/api/system', 'member', { serverIp: null })).status).toBe(403);
  });

  test('cannot mint an API token, which would hand them everything', async () => {
    const response = await call('POST', '/api/tokens', 'member', { name: 'sneaky' });
    expect(response.status).toBe(403);

    const list = (await (await call('GET', '/api/tokens', 'owner')).json()) as {
      tokens: unknown[];
    };
    expect(list.tokens).toHaveLength(0);
  });

  test('cannot add people, or promote themselves', async () => {
    expect((await call('POST', '/api/people', 'member', { ...VIEWER, role: 'owner' })).status).toBe(
      403,
    );
  });
});

describe('changing what somebody can do', () => {
  test('an owner can promote a viewer to a member', async () => {
    const people = (await (await call('GET', '/api/people', 'owner')).json()) as {
      people: { id: string; email: string }[];
    };
    const viewer = people.people.find((person) => person.email === VIEWER.email)!;

    const response = await call('PUT', `/api/people/${viewer.id}/role`, 'owner', {
      role: 'member',
    });
    expect(response.status).toBe(200);

    // Their existing session keeps working and simply means more than it did.
    expect((await call('POST', '/api/projects', 'viewer', { name: 'Now Allowed' })).status).toBe(
      201,
    );
  });

  test('an owner cannot reduce their own access', async () => {
    const body = (await (await call('GET', '/api/people', 'owner')).json()) as { you: string };
    const response = await call('PUT', `/api/people/${body.you}/role`, 'owner', {
      role: 'viewer',
    });
    expect(response.status).toBe(400);
  });

  test('an owner cannot remove their own account', async () => {
    const body = (await (await call('GET', '/api/people', 'owner')).json()) as { you: string };
    expect((await call('DELETE', `/api/people/${body.you}`, 'owner')).status).toBe(400);
  });

  test('removing somebody ends their session immediately', async () => {
    const people = (await (await call('GET', '/api/people', 'owner')).json()) as {
      people: { id: string; email: string }[];
    };
    const member = people.people.find((person) => person.email === MEMBER.email)!;

    expect((await call('DELETE', `/api/people/${member.id}`, 'owner')).status).toBe(200);

    // Not at the next sign-in. Now.
    expect((await call('GET', '/api/projects', 'member')).status).toBe(401);
  });
});

describe('an API token', () => {
  test('still stands in for an owner', async () => {
    const created = (await (
      await call('POST', '/api/tokens', 'owner', { name: 'for a script' })
    ).json()) as { secret: string };

    const response = await app.request('/api/system/stats', {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(response.status).toBe(200);

    // And can still do owner-only things, because that is what it has always meant
    // and scripts depend on it.
    const patch = await app.request('/api/system', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverIp: null }),
    });
    expect(patch.status).toBe(200);
  });
});
