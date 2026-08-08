import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, initDb } from '../src/db/index.ts';
import { createDomain } from '../src/db/repo/domains.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { checkNow, historyFor, summaryFor } from '../src/runtime/uptime.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Whether the sites are up, and what the public is told about it.
 *
 * The second half matters more than it looks. A status page is something you send to
 * a client or put in a README, so what it does *not* say is part of the design: a
 * failure reason can name an upstream, a port or a container, and none of that is
 * anybody else's business.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-uptime-'));
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

/**
 * A monitor fetches a name somebody typed, on a timer, from inside the network the apps
 * and databases sit on, and it is reachable by a member, not just an owner. So it is
 * exactly the "arbitrary address from somebody who is not necessarily an owner" that the
 * template fetcher is, and it is held to the same rule: a name that lands on this machine
 * or its private network is refused before a single connection is opened. Otherwise the
 * check's own result, "answered" or "could not be reached", is a scanner for the one part
 * of the network the panel is meant to keep to itself.
 */
describe('a monitor pointed at the inside of the network', () => {
  test('refuses to probe it, and never opens the connection', async () => {
    const project = createProject('Probe');
    const service = createAppService({
      projectId: project.id,
      name: 'Web',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
    });
    // A name that resolves onto this machine. `checkNow` builds `http://localhost/` from
    // it, and the guard resolves the host before dialling.
    const domain = createDomain(service.id, 'localhost', 'custom');

    const realFetch = globalThis.fetch;
    let dialled = false;
    globalThis.fetch = (async () => {
      dialled = true;
      throw new Error('the probe should never have dialled a blocked address');
    }) as unknown as typeof fetch;
    try {
      const result = await checkNow(domain.id);
      expect(result.up).toBe(false);
      expect(dialled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the record of what happened', () => {
  test('says nothing about a domain nothing has checked', () => {
    const summary = summaryFor('nope');
    expect(summary.up).toBeNull();
    expect(summary.uptimePercent).toBeNull();
    expect(summary.days).toEqual([]);
  });

  test('rounds a percentage down rather than up', () => {
    // A status page claiming 100% on a day something broke is worse than one
    // admitting a dip, so 99.95 must show as 99.9 and never as 100.
    const project = createProject('Shop');
    const service = createAppService({
      projectId: project.id,
      name: 'Web',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
    });
    const domain = createDomain(service.id, 'rounding.example.com', 'custom');

    const now = Date.now();
    for (let index = 0; index < 1999; index++) {
      db()
        .query('INSERT INTO uptime_checks (id, domain_id, at, up, ms) VALUES (?, ?, ?, 1, 10)')
        .run(`up-${index}`, domain.id, now);
    }
    db()
      .query('INSERT INTO uptime_checks (id, domain_id, at, up, ms) VALUES (?, ?, ?, 0, 10)')
      .run('down-1', domain.id, now);

    expect(historyFor(domain.id)[0]?.uptimePercent).toBe(99.9);
  });
});

describe('the public page', () => {
  test('is not there until it is switched on', async () => {
    const response = await app.request('/api/public/status.json', {
      headers: { 'x-requested-with': 'derailed' },
    });
    expect(response.status).toBe(404);
  });

  test('is readable without signing in once it is', async () => {
    expect((await call('PUT', '/api/uptime/status-page', { enabled: true })).status).toBe(200);

    // No cookie at all, which is the whole point of it.
    const response = await app.request('/api/public/status.json', {
      headers: { 'x-requested-with': 'derailed' },
    });
    expect(response.status).toBe(200);
  });

  test('gives away nothing about the machine', async () => {
    await call('PUT', '/api/uptime/status-page', { enabled: true, title: 'My Status' });

    const response = await app.request('/api/public/status.json', {
      headers: { 'x-requested-with': 'derailed' },
    });
    const text = await response.text();

    expect(text).toContain('My Status');
    // Names and shapes only. A reason can carry an upstream, a port or a container
    // name, and none of that belongs on a page anybody can read.
    for (const leak of ['reason', 'serviceId', 'container', 'upstream', 'projectId', 'version']) {
      expect(text).not.toContain(leak);
    }
  });

  test('needs a session to change', async () => {
    const anonymous = await app.request('/api/uptime/status-page', {
      method: 'PUT',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(anonymous.status).toBe(401);
  });

  test('needs a session to read the private view', async () => {
    const anonymous = await app.request('/api/uptime', {
      headers: { 'x-requested-with': 'derailed' },
    });
    expect(anonymous.status).toBe(401);
  });
});
