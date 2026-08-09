/**
 * Every mutating route, met with a malformed body.
 *
 * `schema-fuzz.test.ts` proves the invariant on a hand-picked few; this proves it on
 * all of them. It walks the mounted router the way the permission matrix does, takes
 * every POST, PUT, PATCH and DELETE, and drives each one, as an owner, with a corpus of
 * bodies a careless client or an attacker actually sends: not JSON, the wrong root type,
 * a null, a truncated object, a field of the wrong type. The one thing none of them may
 * do is return a 500. A malformed request is the caller's mistake and deserves a clean
 * 4xx; a 500 is the server admitting the body reached code that was not ready for it,
 * which is exactly the class of bug that put a null through sixty handlers before.
 *
 * A new route is covered the moment it is mounted, with nothing to remember to add.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, createDatabaseService } from '../src/db/repo/services.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loginLimiter, peerLimiter, setupLimiter } from '../src/http/routes/auth.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-schemafuzz-all-'));
let app: ReturnType<typeof createApp>;
let ownerCookie = '';
let projectId = '';
let appId = '';
let dbId = '';

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const hash = await Bun.password.hash('correct-horse');
  const owner = createUser('owner@fuzzall.test', hash, 'owner');
  ownerCookie = `derailed_session=${createSession(owner.id).id}`;
  // Real fixtures so `:id` params resolve and the body-parse path is actually reached,
  // rather than every route 404-ing on a made-up id before it ever looks at the body.
  const project = createProject('Fuzzed');
  projectId = project.id;
  appId = createAppService({
    projectId,
    name: 'web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  }).id;
  // Just the row, not a running container: this is a unit test, and a real database
  // would drag Docker into it for no reason. The row is enough for `:id` to resolve.
  dbId = createDatabaseService({
    projectId,
    name: 'db',
    engine: 'postgres',
    version: '16',
    dbName: 'db',
    dbUser: 'db',
    dbPassword: 'secret',
    port: null,
  }).id;
});

afterAll(async () => {
  // The auth routes are among those swept, so their rate limiters get spent; hand them
  // back so the next test file's setup or login is not met with a stray 429.
  setupLimiter.resetAll();
  loginLimiter.resetAll();
  peerLimiter.resetAll();
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Fill `:params` with real ids where the path tells us the kind, so the handler gets
 * past its "does this exist?" check and actually parses the body. A `:id` under
 * `/services` is a service; under `/projects` it is a project; the rest fall back to a
 * value that matches nothing but offends no regex.
 */
function concrete(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    if (name === 'id' && path.startsWith('/api/services')) return dbId; // a db so browse/query resolve too
    if (name === 'id' && path.startsWith('/api/projects')) return projectId;
    if (name === 'serviceId') return appId;
    if (name === 'id' && path.startsWith('/api/deployments')) return 'x1';
    return 'x1';
  });
}

function mutatingRoutes(): { method: string; path: string }[] {
  const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const seen = new Map<string, { method: string; path: string }>();
  for (const r of app.routes) {
    if (!mutating.has(r.method)) continue;
    if (r.path.includes('*')) continue;
    const key = `${r.method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, { method: r.method, path: r.path });
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const MALFORMED = [
  'not json at all {',
  '',
  'null',
  '[]',
  '"a string"',
  '12345',
  'true',
  '{',
  '{"a":',
  '{"unexpected":"field"}',
  '{"vars":null}',
  '{"vars":123}',
  '{"items":[1,2,3]}',
  `{"x":"${'A'.repeat(2000)}"}`,
];

async function send(method: string, path: string, body: string): Promise<Response> {
  return app.request(concrete(path), {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      cookie: ownerCookie,
    },
    body,
  });
}

describe('a malformed body is never a 500, on any mutating route', () => {
  test('every mounted POST/PUT/PATCH/DELETE answers a 4xx, not a 5xx, for any junk body', async () => {
    const routes = mutatingRoutes();
    // A guard against the walk quietly finding nothing.
    expect(routes.length).toBeGreaterThan(80);

    const failures: string[] = [];
    for (const { method, path } of routes) {
      for (const body of MALFORMED) {
        const res = await send(method, path, body);
        // Drain the body so a streamed response does not hold the connection.
        await res.text().catch(() => undefined);
        if (res.status >= 500) {
          failures.push(
            `${method} ${path} on ${JSON.stringify(body).slice(0, 30)} => ${res.status}`,
          );
        }
      }
    }
    expect(failures, `routes that 500'd on a malformed body:\n  ${failures.join('\n  ')}`).toEqual(
      [],
    );
  });
});
