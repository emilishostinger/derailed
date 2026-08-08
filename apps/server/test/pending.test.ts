import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { envDiff } from '../src/db/repo/pending.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * What will change: edits collect, show a readable diff, and apply together.
 *
 * The joints worth testing: with review off nothing behaves differently; with it
 * on, a save answers "staged" and changes NOTHING until Apply; the diff never
 * carries a variable's value; saving twice replaces the waiting edit rather than
 * queueing both; and an edit whose subject has gone applies as a sentence, not a
 * half-done change that blocks the rest.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-pending-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let projectId: string;
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

  projectId = createProject('Review me').id;
  serviceId = createAppService({
    projectId,
    name: 'Shop',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
    port: 80,
  }).id;
});

function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

describe('with review off, nothing behaves differently', () => {
  test('a save applies at once and lands in the history, keys only', async () => {
    const saved = await call('PUT', `/api/services/${serviceId}/env`, {
      vars: [{ key: 'API_KEY', value: 'first-value' }],
    });
    expect(saved.status).toBe(200);
    expect(listEnv(serviceId).find((entry) => entry.key === 'API_KEY')?.value).toBe('first-value');

    const history = (await (
      await call('GET', `/api/services/${serviceId}/env/history`)
    ).json()) as {
      history: { changes: { key: string; change: string }[] }[];
    };
    expect(history.history[0]!.changes).toEqual([{ key: 'API_KEY', change: 'added' }]);
    // Values never reach the history, by design.
    expect(JSON.stringify(history)).not.toContain('first-value');
  });
});

describe('with review on, edits wait', () => {
  test('the switch, the staging, the diff, and nothing moving until Apply', async () => {
    const toggled = await call('PUT', `/api/projects/${projectId}/review`, { enabled: true });
    expect(toggled.status).toBe(200);

    // 1. An env edit stages rather than applies.
    const saved = await call('PUT', `/api/services/${serviceId}/env`, {
      vars: [
        { key: 'API_KEY', value: 'second-value' },
        { key: 'NEW_FLAG', value: 'on' },
      ],
    });
    expect(saved.status).toBe(202);
    expect(((await saved.json()) as { staged: boolean }).staged).toBe(true);
    expect(listEnv(serviceId).find((entry) => entry.key === 'API_KEY')?.value).toBe('first-value');

    // 2. Saving again replaces the waiting edit rather than queueing both.
    await call('PUT', `/api/services/${serviceId}/env`, {
      vars: [
        { key: 'API_KEY', value: 'third-value' },
        { key: 'NEW_FLAG', value: 'on' },
      ],
    });

    // 3. A settings edit and a domain both stage too.
    const patched = await call('PATCH', `/api/services/${serviceId}`, { port: 8080 });
    expect(patched.status).toBe(202);
    const domained = await call('POST', `/api/services/${serviceId}/domains`, {
      hostname: 'pending-b31.example.com',
    });
    expect(domained.status).toBe(202);
    expect(findService(serviceId)!.port).toBe(80);

    // 4. The queue reads like a story, and never says a value.
    const pending = (await (await call('GET', `/api/projects/${projectId}/pending`)).json()) as {
      changes: { kind: string; summary: string; diff: string[] }[];
    };
    expect(pending.changes).toHaveLength(3);
    const kinds = pending.changes.map((change) => change.kind).sort();
    expect(kinds).toEqual(['domain-attach', 'env', 'setting']);
    const raw = JSON.stringify(pending);
    expect(raw).not.toContain('second-value');
    expect(raw).not.toContain('third-value');
    expect(raw).toContain('API_KEY changed');
    expect(raw).toContain('NEW_FLAG added');
    expect(raw).toContain('port: was 80, now 8080');

    // 5. Apply lands everything, oldest first, in one press.
    const applied = await call('POST', `/api/projects/${projectId}/pending/apply`);
    expect(applied.status).toBe(200);
    const outcome = (await applied.json()) as {
      results: { ok: boolean }[];
      pending: number;
      redeployNeeded: boolean;
    };
    expect(outcome.results.every((entry) => entry.ok)).toBe(true);
    expect(outcome.pending).toBe(0);
    expect(outcome.redeployNeeded).toBe(true);

    expect(listEnv(serviceId).find((entry) => entry.key === 'API_KEY')?.value).toBe('third-value');
    expect(findService(serviceId)!.port).toBe(8080);
    const domains = (await (await call('GET', `/api/services/${serviceId}/domains`)).json()) as {
      domains: { hostname: string }[];
    };
    expect(domains.domains.some((domain) => domain.hostname === 'pending-b31.example.com')).toBe(
      true,
    );
  });

  test('an edit whose app has gone applies as a sentence, and the rest still land', async () => {
    const doomed = createAppService({
      projectId,
      name: 'Doomed',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
    });
    expect((await call('PATCH', `/api/services/${doomed.id}`, { port: 9000 })).status).toBe(202);
    await call('PUT', `/api/services/${serviceId}/env`, {
      vars: [{ key: 'API_KEY', value: 'fourth-value' }],
    });

    // The app the first edit belongs to disappears before Apply.
    expect((await call('DELETE', `/api/services/${doomed.id}`)).status).toBe(200);

    const applied = (await (
      await call('POST', `/api/projects/${projectId}/pending/apply`)
    ).json()) as {
      results: { ok: boolean; note: string | null; summary: string }[];
      pending: number;
    };
    const failedOne = applied.results.find((entry) => !entry.ok);
    const okOnes = applied.results.filter((entry) => entry.ok);
    expect(failedOne?.note).toContain('no longer exists');
    expect(okOnes.length).toBeGreaterThanOrEqual(1);
    expect(listEnv(serviceId).find((entry) => entry.key === 'API_KEY')?.value).toBe('fourth-value');
    // The failed edit stays in the queue with its reason rather than vanishing.
    expect(applied.pending).toBe(1);

    // Discarding it clears the queue.
    const discarded = await call('DELETE', `/api/projects/${projectId}/pending`);
    expect(((await discarded.json()) as { pending: number }).pending).toBe(0);
  });

  test('a save that changes nothing stages nothing', async () => {
    const current = listEnv(serviceId)
      .filter((entry) => entry.source === 'user')
      .map((entry) => ({ key: entry.key, value: entry.value }));
    const saved = await call('PUT', `/api/services/${serviceId}/env`, { vars: current });
    expect(saved.status).toBe(200);
    const pending = (await (await call('GET', `/api/projects/${projectId}/pending`)).json()) as {
      changes: unknown[];
    };
    expect(pending.changes).toHaveLength(0);
  });

  test('turning review off keeps what is waiting rather than losing or firing it', async () => {
    await call('PUT', `/api/services/${serviceId}/env`, {
      vars: [{ key: 'API_KEY', value: 'fifth-value' }],
    });
    await call('PUT', `/api/projects/${projectId}/review`, { enabled: false });

    const pending = (await (await call('GET', `/api/projects/${projectId}/pending`)).json()) as {
      changes: unknown[];
    };
    expect(pending.changes).toHaveLength(1);
    expect(listEnv(serviceId).find((entry) => entry.key === 'API_KEY')?.value).not.toBe(
      'fifth-value',
    );
    await call('DELETE', `/api/projects/${projectId}/pending`);
  });
});

describe('the diff itself', () => {
  test('says added, changed and removed, and sorts by key', () => {
    expect(
      envDiff(
        [
          { key: 'B_GOES', value: '1' },
          { key: 'C_MOVES', value: 'old' },
          { key: 'D_STAYS', value: 'same' },
        ],
        [
          { key: 'A_ARRIVES', value: 'x' },
          { key: 'C_MOVES', value: 'new' },
          { key: 'D_STAYS', value: 'same' },
        ],
      ),
    ).toEqual([
      { key: 'A_ARRIVES', change: 'added' },
      { key: 'B_GOES', change: 'removed' },
      { key: 'C_MOVES', change: 'changed' },
    ]);
  });
});
