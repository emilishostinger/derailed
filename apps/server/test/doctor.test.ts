import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { runDoctor } from '../src/system/doctor.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The health check.
 *
 * Most of what it reports is shown elsewhere; the value is having one list, and the
 * guarantee that a broken check never takes the whole report down with it. The fix
 * endpoint restarts the proxy and deletes images, so what it will and will not accept
 * matters more than what it reports.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-doctor-'));
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

function call(method: string, path: string) {
  return app.request(path, {
    method,
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: method === 'GET' ? undefined : '{}',
  });
}

describe('running the checks', () => {
  // 20s rather than the default 5: Docker's own `/system/df` walks every image and
  // container adding up sizes, which takes seconds on a real machine. The result is
  // cached, so only the first of these pays for it.
  test('always produces a report, whatever the machine looks like', async () => {
    const report = await runDoctor();
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.summary).toBeTruthy();
    expect(['ok', 'warn', 'bad']).toContain(report.level);
  }, 20_000);

  test('gives every check a status and something to read', async () => {
    for (const check of (await runDoctor()).checks) {
      expect(['ok', 'warn', 'bad']).toContain(check.status);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  }, 20_000);

  test('says something needs attention only when something does', async () => {
    const report = await runDoctor();
    const bad = report.checks.filter((check) => check.status === 'bad').length;
    expect(report.level === 'bad').toBe(bad > 0);
  }, 20_000);

  test('nags about backups on a server that has none', async () => {
    // The suite's database has no projects, so this is the "nothing to back up yet"
    // branch rather than the warning. Either is fine; what must not happen is silence.
    const backups = (await runDoctor()).checks.find((check) => check.id === 'backups');
    expect(backups).toBeDefined();
    expect(backups?.detail).toBeTruthy();
  }, 20_000);

  test('warns that the dashboard is on plain HTTP until a domain is set', async () => {
    const panel = (await runDoctor()).checks.find((check) => check.id === 'panel');
    expect(panel?.status).toBe('warn');
    expect(panel?.detail).toContain('unencrypted');
  }, 20_000);
});

describe('the fix endpoint', () => {
  test('is reachable and returns a fresh report', async () => {
    const response = await call('GET', '/api/system/doctor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { report: { checks: unknown[] } };
    expect(body.report.checks.length).toBeGreaterThan(0);
  }, 20_000);

  test('refuses an action it does not know', async () => {
    // This endpoint restarts the proxy and deletes images. "Do whatever this string
    // says" is not a shape it may ever have, so anything unrecognised is a 400 rather
    // than something clever.
    expect((await call('POST', '/api/system/doctor/fix/rm-rf')).status).toBe(400);
    expect((await call('POST', '/api/system/doctor/fix/../../etc')).status).toBe(404);
  });

  test('needs a session', async () => {
    const anonymous = await app.request('/api/system/doctor', {
      headers: { 'x-requested-with': 'derailed' },
    });
    expect(anonymous.status).toBe(401);

    const anonymousFix = await app.request('/api/system/doctor/fix/reclaim-disk', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(anonymousFix.status).toBe(401);
  });

  test('needs the header that proves it is not a cross-site form post', async () => {
    // Without it, any page on the internet could make a logged-in browser reclaim
    // this server's disk simply by submitting a form at it.
    const noHeader = await app.request('/api/system/doctor/fix/reclaim-disk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(noHeader.status).toBe(403);
  });
});
