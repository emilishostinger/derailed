/**
 * The restart-from-the-dashboard pair. What a unit test can honestly cover is
 * the refusals: a development run (or this very test process) must never be
 * exited by the route, and the update route must change nothing when there is
 * nothing it can safely do. The real restart is systemd's Restart=always
 * bringing back a cleanly exited process, which only a live box can show.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-restart-'));
let app: ReturnType<typeof createApp>;
let cookie = '';

const HEADERS = { 'x-requested-with': 'derailed', 'content-type': 'application/json' };

function post(path: string, body: unknown = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const setup = await post('/api/auth/setup', {
    email: 'owner@example.com',
    password: 'a-long-enough-password',
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('restarting from the dashboard', () => {
  test('a development or test run is refused, in words, and stays alive', async () => {
    const response = await post('/api/system/restart');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('development run');
    // The strongest assertion is that this line executes at all.
  });

  test('applying an update from a dev run changes nothing and says why', async () => {
    const response = await post('/api/system/update/apply');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { updated: boolean; log: string[] };
    expect(body.updated).toBe(false);
    expect(body.log.join(' ')).toContain('development');
  });
});
