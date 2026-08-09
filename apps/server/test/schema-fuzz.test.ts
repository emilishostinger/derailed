/**
 * Malformed bodies, thrown at the endpoints that take them.
 *
 * Two whole classes of bug live here. The first is a 500: a handler that reached for
 * zod's throwing `parse`, or read a field by hand, and met a body of the wrong shape
 * with "Something went wrong on the server" instead of a clean 400. On the sign-in
 * route, the one endpoint strangers are meant to reach, every malformed request was
 * once a 500. The second, worse, is a *partial mutation on reject*: `PUT
 * /projects/:id/env` used to fall back to `body.vars ?? []` and so a truncated body
 * emptied every variable in the project and answered 200. Emptying a list has to be
 * something somebody asked for.
 *
 * The bodies are a fixed, enumerated corpus rather than a fast-check generator on
 * purpose: these tests drive the real HTTP app, and every request has to be awaited to
 * completion before the file's teardown, or a late one lands on the next test file's
 * database (the app reads a process-wide handle). A plain awaited loop over a corpus
 * gives that guarantee with no async batching to leak. The corpus is the shapes that
 * actually break a hand-rolled body reader: not JSON, the wrong root type, the right
 * shape with wrong-typed fields, a truncated object, a null.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { listProjectEnv, replaceProjectEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loginLimiter, peerLimiter, setupLimiter } from '../src/http/routes/auth.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-schemafuzz-'));
let app: ReturnType<typeof createApp>;
let ownerCookie = '';
let projectId = '';

const FIXTURE = [
  { key: 'DATABASE_URL', value: 'postgres://u:p@db/app' },
  { key: 'API_KEY', value: 'sk-live-do-not-erase' },
];

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const hash = await Bun.password.hash('correct-horse');
  const owner = createUser('owner@schemafuzz.test', hash, 'owner');
  ownerCookie = `derailed_session=${createSession(owner.id).id}`;
  const project = createProject('Fuzzed');
  projectId = project.id;
  // A real, non-empty variable list, so "the reject did not wipe it" has something to
  // lose.
  replaceProjectEnv(projectId, FIXTURE);
});

afterAll(async () => {
  // This file hammers /api/auth/setup and /api/auth/login with junk to prove they do
  // not 500, which spends the sign-up and sign-in rate limiters. Those are module-level
  // singletons shared across every test file in the process, so leaving them tripped
  // would fail the next file's setup or login with a 429 that has nothing to do with
  // it. Hand them back full.
  setupLimiter.resetAll();
  loginLimiter.resetAll();
  peerLimiter.resetAll();
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

async function send(method: string, path: string, body: string): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      cookie: ownerCookie,
    },
    body,
  });
}

// The bodies a careless client (or an attacker) actually sends.
const MALFORMED = [
  'not json at all {',
  '',
  'null',
  '[]',
  '"a string"',
  '12345',
  'true',
  '{"vars":',
  '{"vars":null}',
  '{"vars":"nope"}',
  '{"vars":{}}',
  '{"vars":[{"key":123,"value":true}]}',
  '{"vars":[{"nope":"nope"}]}',
  '{"vars":[1,2,3]}',
  '{"wrong":"field"}',
  '{"vars":[{"key":"ok","value":"ok"},{"key":"ok","value":"dup"}]}',
  `{"vars":[${'{"key":"K","value":"V"},'.repeat(50)}{"key":"L","value":"M"}]}`,
];

describe('a malformed body is a clean refusal, never a 500', () => {
  // Routes whose body is validated up front, so a bad body is answered by the parser
  // and never reaches anything that needs Docker or the network.
  const endpoints: [string, string][] = [
    ['PUT', '/api/projects/ID/env'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects/ID/env'], // wrong method, still must not 500
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/setup'],
    ['PATCH', '/api/auth/me/password'],
    ['PATCH', '/api/auth/me/email'],
  ];

  test('every mutating endpoint answers a 4xx, not a 5xx, for any junk body', async () => {
    for (const [method, rawPath] of endpoints) {
      const path = rawPath.replace('ID', projectId);
      for (const body of MALFORMED) {
        const res = await send(method, path, body);
        const where = `${method} ${path} on ${JSON.stringify(body)} => ${res.status}`;
        expect(res.status, where).toBeLessThan(500);
      }
    }
  });
});

describe('a rejected env write never partially mutates (the wipe-on-bad-body class)', () => {
  test('PUT /projects/:id/env with any malformed body leaves the variables untouched', async () => {
    replaceProjectEnv(projectId, FIXTURE);
    const before = JSON.stringify(listProjectEnv(projectId));
    expect(listProjectEnv(projectId).length).toBe(2);

    for (const body of MALFORMED) {
      const res = await send('PUT', `/api/projects/${projectId}/env`, body);
      // A malformed replace-all must be refused, and refused before it writes.
      expect(res.status, `body ${JSON.stringify(body)} was not refused`).toBeGreaterThanOrEqual(
        400,
      );
      expect(
        JSON.stringify(listProjectEnv(projectId)),
        `body ${JSON.stringify(body)} mutated`,
      ).toBe(before);
    }

    const after = listProjectEnv(projectId);
    expect(after.map((v) => v.key).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
  });

  test('an absent vars field is an error, not an empty list applied silently', async () => {
    replaceProjectEnv(projectId, FIXTURE);
    const res = await send('PUT', `/api/projects/${projectId}/env`, '{}');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(listProjectEnv(projectId).length).toBe(2);
  });

  test('a well-formed replace still works, so the guard is not just always-refuse', async () => {
    const res = await send(
      'PUT',
      `/api/projects/${projectId}/env`,
      JSON.stringify({ vars: [{ key: 'ONLY', value: 'one' }] }),
    );
    expect(res.status).toBeLessThan(300);
    expect(listProjectEnv(projectId).map((v) => v.key)).toEqual(['ONLY']);
    replaceProjectEnv(projectId, FIXTURE);
  });
});
