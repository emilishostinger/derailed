import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Service } from '@derailed/shared';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The address lists, over HTTP, the way the dashboard uses them.
 *
 * The rules that matter here are the ones a unit test of the repository cannot see:
 * a typo is refused before it reaches the proxy, and blocking the address you are
 * sitting at is refused once and then allowed. The first exists because a bad entry
 * is a config Caddy rejects wholesale, which would take every site on the machine
 * down over one line in one app's settings.
 *
 * Runs without Docker.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-access-e2e-'));
let app: ReturnType<typeof createApp>;
let cookie: string;
let appId = '';

/** What `clientIp` resolves to for these requests, so the self-block guard can fire. */
const MINE = '203.0.113.7';

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

  const project = createProject('Shop');
  appId = createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  }).id;
});

/**
 * A request that looks like it came through the proxy.
 *
 * The peer has to be a private address or `x-forwarded-for` is ignored, which is the
 * right rule and the reason this cannot be done with headers alone: a header anybody
 * can set is not evidence of where anybody is.
 */
function call(method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        'x-forwarded-for': MINE,
        cookie,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    },
    { ip: { address: '127.0.0.1' } },
  );
}

/** The same request with nothing in front of it, so the address is unknown. */
function callDirect(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      'x-forwarded-for': MINE,
      cookie,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function setAccess(body: unknown) {
  return call('PUT', `/api/services/${appId}/access`, body);
}

describe('the address lists over HTTP', () => {
  test('says which address you are here from, so the button can offer it', async () => {
    const response = await call('GET', '/api/system/my-address');
    expect(response.status).toBe(200);
    expect((await json<{ address: string }>(response)).address).toBe(MINE);
  });

  test('keeps both lists, separately', async () => {
    const response = await setAccess({
      allowFrom: ['198.51.100.0/24'],
      blockFrom: ['192.0.2.9'],
    });
    expect(response.status).toBe(200);

    const { service } = await json<{ service: Service }>(response);
    expect(service.access?.allowFrom).toEqual(['198.51.100.0/24']);
    expect(service.access?.blockFrom).toEqual(['192.0.2.9']);
  });

  test('refuses a typo rather than handing it to the proxy', async () => {
    // A bad entry is a config Caddy rejects wholesale, which takes every site on the
    // machine down over one line in one app's settings.
    for (const entry of ['not-an-address', '203.0.113.999', '203.0.113.7/33', 'example.com']) {
      const response = await setAccess({ blockFrom: [entry] });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('not an address or a range');
    }
    for (const entry of ['not-an-address', '10.0.0.0/99']) {
      expect((await setAccess({ allowFrom: [entry] })).status).toBe(400);
    }
  });

  test('accepts the shapes people really paste', async () => {
    for (const entry of ['203.0.113.7', '203.0.113.0/24', '10.0.0.0/8', '2001:db8::1']) {
      expect((await setAccess({ allowFrom: [entry] })).status).toBe(200);
    }
  });

  test('refuses to block you out of your own site, and says why', async () => {
    const response = await setAccess({ blockFrom: ['203.0.113.0/24'] });
    expect(response.status).toBe(400);

    const body = await response.text();
    expect(body).toContain('would block you');
    expect(body).toContain(MINE);
    expect(body).toContain('203.0.113.0/24');
  });

  test('and then lets you, because the second press is the confirmation', async () => {
    // Somebody blocking a range their own ISP happens to be in has a real reason and
    // should not be stuck. The refusal is a speed bump, not a wall.
    const response = await setAccess({ blockFrom: ['203.0.113.0/24'], force: true });
    expect(response.status).toBe(200);
    expect((await json<{ service: Service }>(response)).service.access?.blockFrom).toEqual([
      '203.0.113.0/24',
    ]);
  });

  test('does not object when the block is somebody else', async () => {
    expect((await setAccess({ blockFrom: ['198.51.100.9'] })).status).toBe(200);
  });

  test('does not pretend to know where you are when nothing is in front of it', async () => {
    // `x-forwarded-for` is only believed behind a private peer, because a header
    // anybody can set is not evidence of where anybody is. With no address to
    // compare against there is nothing to warn about, and inventing one would be
    // worse than staying quiet.
    const address = await json<{ address: string }>(
      await callDirect('GET', '/api/system/my-address'),
    );
    expect(address.address).toBe('local');

    const response = await callDirect('PUT', `/api/services/${appId}/access`, {
      blockFrom: ['203.0.113.0/24'],
    });
    expect(response.status).toBe(200);
  });

  test('leaves the other list alone when only one is sent', async () => {
    await setAccess({ allowFrom: ['198.51.100.0/24'], blockFrom: ['192.0.2.9'] });
    const response = await setAccess({ maintenance: true });

    const { service } = await json<{ service: Service }>(response);
    expect(service.access?.allowFrom).toEqual(['198.51.100.0/24']);
    expect(service.access?.blockFrom).toEqual(['192.0.2.9']);
    expect(service.access?.maintenance).toBe(true);
  });

  test('clears a list when it is emptied', async () => {
    const response = await setAccess({ blockFrom: [] });
    expect((await json<{ service: Service }>(response)).service.access?.blockFrom).toEqual([]);
  });
});
