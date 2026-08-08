import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { getSetting, SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * DNS records, written for you, against a pretend Cloudflare.
 *
 * The joints worth testing: the token is stored encrypted and proven at paste
 * time (a bad one fails while the paster is looking, and is not kept); a
 * hostname finds its zone by the longest suffix; an apex gets the A, the www
 * CNAME and the wildcard while a subdomain gets only its own record; and every
 * record is written DNS-only, because the orange cloud is how certificates
 * quietly stop arriving.
 */

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

const seen: Seen[] = [];
let existing: { id: string; type: string; name: string; content: string }[] = [];
let tokenOk = true;

const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname + url.search,
      body: request.method === 'GET' ? null : await request.json().catch(() => null),
    });
    if (!tokenOk) {
      return Response.json(
        { success: false, errors: [{ message: 'Invalid API Token' }] },
        { status: 403 },
      );
    }
    if (url.pathname === '/zones') {
      return Response.json({
        success: true,
        result: [
          { id: 'z1', name: 'example.com' },
          { id: 'z2', name: 'shop.example.com' },
        ],
      });
    }
    if (url.pathname === '/zones/z1/dns_records' && request.method === 'GET') {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      return Response.json({
        success: true,
        result: existing.filter((entry) => entry.name === name && entry.type === type),
      });
    }
    return Response.json({ success: true, result: {} });
  },
});

const dir = mkdtempSync(join(tmpdir(), 'derailed-clouddns-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let clouddns: typeof import('../src/proxy/clouddns.ts');

beforeAll(async () => {
  process.env.DERAILED_CLOUDFLARE_API = `http://127.0.0.1:${fake.port}`;
  clouddns = await import('../src/proxy/clouddns.ts');

  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  setSetting(SETTINGS.serverIp, '203.0.113.7');
  app = createApp();
  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

afterAll(() => {
  fake.stop(true);
});

function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

describe('the token', () => {
  test('a bad paste fails while the paster is looking, and is not kept', async () => {
    tokenOk = false;
    const response = await call('PUT', '/api/system/dns', { token: 'cf-bad-token' });
    expect(response.status).toBe(400);
    expect(clouddns.hasDnsToken()).toBe(false);
    tokenOk = true;
  });

  test('a good one lists the zones, is stored encrypted, and never comes back', async () => {
    const response = await call('PUT', '/api/system/dns', { token: 'cf-good-token' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { configured: boolean; zones: { name: string }[] };
    expect(body.configured).toBe(true);
    expect(body.zones.map((zone) => zone.name)).toContain('example.com');

    const stored = getSetting(SETTINGS.cloudflareToken) ?? '';
    expect(stored).not.toContain('cf-good-token');
    expect(JSON.stringify(body)).not.toContain('cf-good-token');
  });

  test('only an owner can hold it', () => {
    expect(mayCall('member', 'PUT', '/api/system/dns').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/system/dns/write').ok).toBe(false);
    expect(mayCall('member', 'GET', '/api/system/dns').ok).toBe(true);
  });
});

describe('finding the zone', () => {
  test('the longest suffix wins', () => {
    const zones = [
      { id: 'z1', name: 'example.com' },
      { id: 'z2', name: 'shop.example.com' },
    ];
    expect(clouddns.zoneFor('shop.example.com', zones)?.id).toBe('z2');
    expect(clouddns.zoneFor('a.shop.example.com', zones)?.id).toBe('z2');
    expect(clouddns.zoneFor('blog.example.com', zones)?.id).toBe('z1');
    expect(clouddns.zoneFor('example.org', zones)).toBeNull();
    // A name that merely ends with the letters is not inside the zone.
    expect(clouddns.zoneFor('notexample.com', zones)).toBeNull();
  });
});

describe('writing the records', () => {
  test('an apex gets the A, the www CNAME and the wildcard, all DNS-only', async () => {
    seen.length = 0;
    existing = [];
    const response = await call('POST', '/api/system/dns/write', {
      hostname: 'example.com',
      wildcard: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      zone: string;
      records: { name: string; type: string; content: string; outcome: string }[];
    };
    expect(body.zone).toBe('example.com');
    expect(body.records).toEqual([
      { name: 'example.com', type: 'A', content: '203.0.113.7', outcome: 'created' },
      { name: 'www.example.com', type: 'CNAME', content: 'example.com', outcome: 'created' },
      { name: '*.example.com', type: 'A', content: '203.0.113.7', outcome: 'created' },
    ]);

    const writes = seen.filter((entry) => entry.method === 'POST');
    expect(writes).toHaveLength(3);
    for (const write of writes) {
      expect((write.body as { proxied: boolean }).proxied).toBe(false);
    }
  });

  test('a subdomain gets only its own record', async () => {
    seen.length = 0;
    const response = await call('POST', '/api/system/dns/write', {
      hostname: 'blog.example.com',
    });
    const body = (await response.json()) as { records: { name: string }[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.name).toBe('blog.example.com');
  });

  test('a record already saying the right thing is kept, a wrong one is corrected', async () => {
    existing = [
      { id: 'r1', type: 'A', name: 'example.com', content: '203.0.113.7' },
      { id: 'r2', type: 'CNAME', name: 'www.example.com', content: 'somewhere-else.net' },
    ];
    seen.length = 0;
    const response = await call('POST', '/api/system/dns/write', { hostname: 'example.com' });
    const body = (await response.json()) as { records: { name: string; outcome: string }[] };
    expect(body.records.find((entry) => entry.name === 'example.com')?.outcome).toBe('kept');
    expect(body.records.find((entry) => entry.name === 'www.example.com')?.outcome).toBe('updated');
    const put = seen.find((entry) => entry.method === 'PUT');
    expect(put?.path).toContain('/dns_records/r2');
  });

  test('a domain in nobody’s zone is refused with the zones named', async () => {
    const response = await call('POST', '/api/system/dns/write', { hostname: 'other.org' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { hint?: string } };
    expect(body.error.hint).toContain('example.com');
  });
});
