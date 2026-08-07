import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import {
  effectiveEnv,
  envMap,
  listEnv,
  listProjectEnv,
  replaceProjectEnv,
  replaceUserEnv,
  setEnv,
} from '../src/db/repo/env.ts';
import { createProject, deleteProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Variables set once for a whole project.
 *
 * The only interesting question is which value wins, and the answer has to be the
 * app's own. A shared variable is a default: an app that needs a different one sets
 * it and wins, without anybody having to remove it from the project first. The other
 * way round, the shared list becomes a thing you fight the moment one app differs.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-projectenv-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function project(name = 'Shop') {
  const made = createProject(name);
  const app = createAppService({
    projectId: made.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
  return { project: made, app };
}

describe('what an app ends up with', () => {
  test('the project variables, when it has none of its own', () => {
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [
      { key: 'SENTRY_DSN', value: 'https://key@sentry.example/1' },
      { key: 'TZ', value: 'Europe/Vilnius' },
    ]);

    expect(envMap(app.id)).toEqual({
      SENTRY_DSN: 'https://key@sentry.example/1',
      TZ: 'Europe/Vilnius',
    });
  });

  test('its own value when it has one, because a shared value is a default', () => {
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [{ key: 'TZ', value: 'Europe/Vilnius' }]);
    replaceUserEnv(app.id, [{ key: 'TZ', value: 'UTC' }]);

    expect(envMap(app.id).TZ).toBe('UTC');
    // And the shared one is not also listed, or the screen would show two rows called
    // TZ and no way to tell which is in force.
    expect(effectiveEnv(app.id).filter((entry) => entry.key === 'TZ')).toHaveLength(1);
    expect(effectiveEnv(app.id).find((entry) => entry.key === 'TZ')?.source).toBe('user');
  });

  test('both, merged and sorted, when they do not collide', () => {
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [{ key: 'SHARED', value: 'from project' }]);
    replaceUserEnv(app.id, [{ key: 'OWN', value: 'from app' }]);

    expect(effectiveEnv(app.id).map((entry) => `${entry.key}=${entry.value}`)).toEqual([
      'OWN=from app',
      'SHARED=from project',
    ]);
  });

  test('a shared variable is marked as one, so the screen can say where to change it', () => {
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [{ key: 'SHARED', value: 'x' }]);

    const shared = effectiveEnv(app.id).find((entry) => entry.key === 'SHARED');
    expect(shared?.source).toBe('project');
    // Never a stored row, so its id is a label rather than a key anything writes to.
    expect(shared?.id).toBe('project:SHARED');
  });

  test('a linked variable still wins over a shared one', () => {
    // A connection string Derailed injected points at a real container. A project
    // default of the same name would be a guess, and the guess must not win.
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [{ key: 'DATABASE_URL', value: 'postgres://guess' }]);
    setEnv(app.id, 'DATABASE_URL', 'postgres://real', 'link');

    expect(envMap(app.id).DATABASE_URL).toBe('postgres://real');
  });
});

describe('what the project list itself holds', () => {
  test('replaces wholesale, so removing a row removes the variable', () => {
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]);
    replaceProjectEnv(shop.id, [{ key: 'A', value: '1' }]);

    expect(listProjectEnv(shop.id).map((entry) => entry.key)).toEqual(['A']);
  });

  test('is encrypted at rest, like every other value', () => {
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [{ key: 'TOKEN', value: 'a-real-secret' }]);

    const { db } = require('../src/db/index.ts') as typeof import('../src/db/index.ts');
    const row = db().query<{ value_enc: string }, []>('SELECT value_enc FROM project_env').get();
    expect(row?.value_enc).not.toContain('a-real-secret');
    expect(listProjectEnv(shop.id)[0]?.value).toBe('a-real-secret');
  });

  test('does not leak into another project', () => {
    const { project: shop } = project('Shop');
    const { app: otherApp } = project('Other');
    replaceProjectEnv(shop.id, [{ key: 'SHARED', value: 'shop only' }]);

    expect(envMap(otherApp.id)).toEqual({});
  });

  test('goes when the project goes', () => {
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [{ key: 'A', value: '1' }]);
    deleteProject(shop.id);
    expect(listProjectEnv(shop.id)).toEqual([]);
  });

  test('leaves the app own rows alone', () => {
    // `listEnv` is what the write path replaces, and it must keep meaning "this app's
    // own", or saving the Variables tab would start deleting the project's.
    const { project: shop, app } = project();
    replaceProjectEnv(shop.id, [{ key: 'SHARED', value: 'x' }]);
    replaceUserEnv(app.id, [{ key: 'OWN', value: 'y' }]);

    expect(listEnv(app.id).map((entry) => entry.key)).toEqual(['OWN']);
    expect(listProjectEnv(shop.id).map((entry) => entry.key)).toEqual(['SHARED']);
  });
});

/**
 * Saving the shared list, over HTTP.
 *
 * `PUT /projects/:id/env` replaces the whole list, and it used to read the body by
 * hand and fall back to `body.vars ?? []`. On a replace-all endpoint that is the worst
 * available default: a request whose body was the wrong shape, or truncated in
 * transit, deleted every variable in the project, answered 200, and helpfully added
 * "redeploy for this to take effect".
 *
 * Found by sending the wrong shape on purpose against a running server and noticing
 * that it was cheerfully accepted.
 */
describe('saving the shared list over HTTP', () => {
  async function signedIn() {
    const app = createApp();
    const user = createUser('owner@example.com', await Bun.password.hash('correct-horse'));
    const cookie = `derailed_session=${createSession(user.id).id}`;
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    return { call };
  }

  test('a body of the wrong shape is refused, and changes nothing', async () => {
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [{ key: 'KEEP', value: 'me' }]);
    const { call } = await signedIn();

    // The shape the old hand-rolled parser silently read as "none".
    const response = await call('PUT', `/api/projects/${shop.id}/env`, { env: { KEEP: 'me' } });
    expect(response.status).toBe(400);
    expect(listProjectEnv(shop.id).map((entry) => entry.key)).toEqual(['KEEP']);
  });

  test('so is a body with no vars at all', async () => {
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [{ key: 'KEEP', value: 'me' }]);
    const { call } = await signedIn();

    expect((await call('PUT', `/api/projects/${shop.id}/env`, {})).status).toBe(400);
    expect(listProjectEnv(shop.id).map((entry) => entry.key)).toEqual(['KEEP']);
  });

  test('but an empty list somebody actually sent still empties it', async () => {
    // Emptying has to stay possible: the difference is that it is now asked for.
    const { project: shop } = project();
    replaceProjectEnv(shop.id, [{ key: 'GO', value: 'away' }]);
    const { call } = await signedIn();

    expect((await call('PUT', `/api/projects/${shop.id}/env`, { vars: [] })).status).toBe(200);
    expect(listProjectEnv(shop.id)).toEqual([]);
  });

  test('and a good list is saved', async () => {
    const { project: shop } = project();
    const { call } = await signedIn();

    const response = await call('PUT', `/api/projects/${shop.id}/env`, {
      vars: [{ key: 'TZ', value: 'Europe/Vilnius' }],
    });
    expect(response.status).toBe(200);
    expect(listProjectEnv(shop.id)[0]).toMatchObject({ key: 'TZ', value: 'Europe/Vilnius' });
  });

  test('a name that is not a name is still refused', async () => {
    const { project: shop } = project();
    const { call } = await signedIn();

    const response = await call('PUT', `/api/projects/${shop.id}/env`, {
      vars: [{ key: '9BAD', value: 'x' }],
    });
    expect(response.status).toBe(400);
  });

  test('and the same name twice is refused rather than quietly deduped', async () => {
    const { project: shop } = project();
    const { call } = await signedIn();

    const response = await call('PUT', `/api/projects/${shop.id}/env`, {
      vars: [
        { key: 'SAME', value: 'one' },
        { key: 'SAME', value: 'two' },
      ],
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { message: string } };
    expect(error.message).toContain('twice');
  });
});
