import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portAccepts } from '../src/build/pipeline.ts';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { probe } from '../src/runtime/uptime.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Health checks that speak the app's language.
 *
 * One dropdown grew from two answers to five, and the new three each carry a word or
 * a command with them. What is worth testing is the joints: a check that arrives
 * without its words must be refused at save time rather than discovered as a deploy
 * that can never finish, and the contains check must hold the live site to the same
 * words the deploy was held to.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-health-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let serviceId: string;

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

  const project = createProject('Health');
  serviceId = createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  }).id;
});

function patch(body: unknown) {
  return app.request(`/api/services/${serviceId}`, {
    method: 'PATCH',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('saving a health check', () => {
  test('a check that needs words refuses to arrive without them', async () => {
    const response = await patch({ healthCheck: 'contains' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('contain');
  });

  test('a command check refuses to arrive without its command', async () => {
    const response = await patch({ healthCheck: 'command' });
    expect(response.status).toBe(400);
  });

  test('whole checks are saved and read back', async () => {
    expect((await patch({ healthCheck: 'contains', healthExpect: 'Welcome' })).status).toBe(200);
    let service = findService(serviceId)!;
    expect(service.healthCheck).toBe('contains');
    expect(service.healthExpect).toBe('Welcome');

    expect((await patch({ healthCheck: 'command', healthCommand: 'redis-cli ping' })).status).toBe(
      200,
    );
    service = findService(serviceId)!;
    expect(service.healthCheck).toBe('command');
    expect(service.healthCommand).toBe('redis-cli ping');

    expect((await patch({ healthCheck: 'tcp' })).status).toBe(200);
    expect(findService(serviceId)!.healthCheck).toBe('tcp');
  });

  test('an unknown kind is refused by the schema', async () => {
    expect((await patch({ healthCheck: 'vibes' })).status).toBe(400);
  });

  test('switching kinds keeps the stored words, so switching back costs nothing', async () => {
    await patch({ healthCheck: 'contains', healthExpect: 'Welcome' });
    await patch({ healthCheck: 'http' });
    // The words survive the switch away; only sending null clears them.
    await patch({ healthCheck: 'contains' });
    expect(findService(serviceId)!.healthExpect).toBe('Welcome');
  });
});

describe('one TCP dial', () => {
  test('answers true for a listening port and false for a closed one', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    try {
      expect(await portAccepts(listener.port)).toBe(true);
    } finally {
      listener.stop(true);
    }
    expect(await portAccepts(listener.port, 500)).toBe(false);
  });
});

describe('the monitor holds the site to the same words', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  function answerWith(body: string, status = 200) {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  test('a page that says the words is up', async () => {
    answerWith('<h1>Welcome to the shop</h1>');
    const result = await probe('http://8.8.8.8/', 'Welcome');
    expect(result.up).toBe(true);
  });

  test('a 200 that no longer says them is down, and the reason says so', async () => {
    answerWith('<h1>Something went wrong</h1>');
    const result = await probe('http://8.8.8.8/', 'Welcome');
    expect(result.up).toBe(false);
    expect(result.reason).toContain('never said');
    expect(result.reason).toContain('Welcome');
  });

  test('with no words asked for, any answer still counts', async () => {
    answerWith('<h1>Something went wrong</h1>');
    const result = await probe('http://8.8.8.8/');
    expect(result.up).toBe(true);
  });

  test('a real failure still reads as one, whatever the body says', async () => {
    answerWith('Welcome, sort of', 502);
    const result = await probe('http://8.8.8.8/', 'Welcome');
    expect(result.up).toBe(false);
    expect(result.reason).toContain('502');
  });
});
