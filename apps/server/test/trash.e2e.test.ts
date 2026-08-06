import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { findServiceEvenIfDeleted } from '../src/db/repo/services.ts';
import { createVolume, listVolumesFor } from '../src/db/repo/volumes.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Deleting and undeleting, over HTTP, the way the dashboard does it.
 *
 * The unit tests cover the repository rules. This covers the thing that actually has
 * to hold: press Delete, and the record of where your data lives is still there
 * afterwards. It runs without Docker, so the container teardown inside the route is a
 * no-op here; everything this asserts is about what survives in the database.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-trash-e2e-'));
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function makeProjectWithApp(name: string) {
  const project = await json<{ project: { id: string; slug: string } }>(
    await call('POST', '/api/projects', { name }),
  );
  const service = await json<{ service: { id: string } }>(
    await call('POST', `/api/projects/${project.project.id}/services`, {
      kind: 'app',
      name: 'Site',
      source: 'image',
      image: 'nginx:alpine',
      deployNow: false,
    }),
  );
  return { projectId: project.project.id, serviceId: service.service.id };
}

describe('deleting an app over the API', () => {
  test('leaves its stored folders exactly where they were', async () => {
    const { serviceId } = await makeProjectWithApp('Keeps Data');
    createVolume(serviceId, '/var/www/html');

    const deleted = await call('DELETE', `/api/services/${serviceId}`);
    expect(deleted.status).toBe(200);
    expect(await json<{ undoable: boolean }>(deleted)).toMatchObject({ undoable: true });

    // The row that says where the data lives is the thing that must not go: without
    // it the Docker volume is orphaned on the host with nothing pointing at it.
    expect(listVolumesFor(serviceId)).toHaveLength(1);
    expect(findServiceEvenIfDeleted(serviceId)?.deletedAt).toBeNumber();
  });

  test('takes it out of the project immediately', async () => {
    const { projectId, serviceId } = await makeProjectWithApp('Gone At Once');
    await call('DELETE', `/api/services/${serviceId}`);

    const after = await json<{ project: { services: unknown[] } }>(
      await call('GET', `/api/projects/${projectId}`),
    );
    expect(after.project.services).toHaveLength(0);
    expect((await call('GET', `/api/services/${serviceId}`)).status).toBe(404);
  });

  test('shows up in the trash, saying what was kept', async () => {
    const { serviceId } = await makeProjectWithApp('In The Trash');
    createVolume(serviceId, '/data');
    await call('DELETE', `/api/services/${serviceId}`);

    const { items } = await json<{ items: { id: string; whatIsKept: string[] }[] }>(
      await call('GET', '/api/trash'),
    );
    const mine = items.find((item) => item.id === serviceId);
    expect(mine).toBeDefined();
    expect(mine?.whatIsKept.join(' ')).toContain('stored files');
  });

  test('comes back, with its storage still attached', async () => {
    const { projectId, serviceId } = await makeProjectWithApp('Comes Back');
    createVolume(serviceId, '/data');
    await call('DELETE', `/api/services/${serviceId}`);

    const restored = await call('POST', `/api/trash/service/${serviceId}/restore`);
    expect(restored.status).toBe(200);

    expect((await call('GET', `/api/services/${serviceId}`)).status).toBe(200);
    const after = await json<{ project: { services: unknown[] } }>(
      await call('GET', `/api/projects/${projectId}`),
    );
    expect(after.project.services).toHaveLength(1);
    expect(listVolumesFor(serviceId)).toHaveLength(1);
  });
});

describe('deleting a project over the API', () => {
  test('hides it and its apps, then brings both back together', async () => {
    const { projectId, serviceId } = await makeProjectWithApp('Whole Project');

    expect((await call('DELETE', `/api/projects/${projectId}`)).status).toBe(200);
    expect((await call('GET', `/api/projects/${projectId}`)).status).toBe(404);
    expect((await call('GET', `/api/services/${serviceId}`)).status).toBe(404);

    const { projects } = await json<{ projects: { id: string }[] }>(
      await call('GET', '/api/projects'),
    );
    expect(projects.some((project) => project.id === projectId)).toBe(false);

    await call('POST', `/api/trash/project/${projectId}/restore`);
    expect((await call('GET', `/api/projects/${projectId}`)).status).toBe(200);
    expect((await call('GET', `/api/services/${serviceId}`)).status).toBe(200);
  });

  test('is listed once in the trash, not once per app', async () => {
    const { projectId } = await makeProjectWithApp('Listed Once');
    await call('DELETE', `/api/projects/${projectId}`);

    const { items } = await json<{ items: { id: string; kind: string }[] }>(
      await call('GET', '/api/trash'),
    );
    expect(items.filter((item) => item.id === projectId)).toHaveLength(1);
    expect(items.find((item) => item.id === projectId)?.kind).toBe('project');
  });
});

describe('the trash refuses what it should', () => {
  test('will not restore something that was never deleted', async () => {
    const { serviceId } = await makeProjectWithApp('Still Here');
    expect((await call('POST', `/api/trash/service/${serviceId}/restore`)).status).toBe(404);
  });

  test('will not empty something that was never deleted', async () => {
    const { serviceId } = await makeProjectWithApp('Also Still Here');
    expect((await call('DELETE', `/api/trash/service/${serviceId}`)).status).toBe(404);
  });

  test('rejects a kind it does not keep', async () => {
    expect((await call('POST', '/api/trash/database/anything/restore')).status).toBe(400);
  });

  test('needs a session, like everything else', async () => {
    const anonymous = await app.request('/api/trash', {
      headers: { 'x-requested-with': 'derailed' },
    });
    expect(anonymous.status).toBe(401);
  });
});
