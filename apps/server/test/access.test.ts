import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { accessFor, createAppService, findService, setAccess } from '../src/db/repo/services.ts';
import { coversAddress } from '../src/http/routes/services.ts';
import { synthesizeCaddyConfig } from '../src/proxy/routes.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Deciding who gets to see an app.
 *
 * All of it is enforced by the proxy, which is the point: it works for WordPress, for
 * a folder of HTML, and for something written in a language nobody here has heard of,
 * without any of them being changed. So the tests are about what ends up in the proxy
 * configuration, and about the password never coming back out.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-access-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function anApp() {
  const project = createProject('Shop');
  return createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
}

describe('a password on a site', () => {
  test('is stored hashed, and never comes back', async () => {
    const app = anApp();
    await setAccess(app.id, { username: 'friend', password: 'open sesame' });

    const service = findService(app.id);
    expect(service?.access?.hasPassword).toBe(true);
    expect(service?.access?.username).toBe('friend');
    // The whole service object goes to the browser, so the password must not be
    // anywhere in it, hashed or otherwise.
    expect(JSON.stringify(service)).not.toContain('open sesame');
    expect(JSON.stringify(service)).not.toContain('$2');
  });

  test('is a bcrypt hash, because that is what the proxy checks', async () => {
    const app = anApp();
    await setAccess(app.id, { username: 'friend', password: 'open sesame' });

    const stored = accessFor(app.id);
    expect(stored?.hash).toStartWith('$2');
    expect(await Bun.password.verify('open sesame', stored?.hash ?? '')).toBe(true);
    expect(await Bun.password.verify('wrong', stored?.hash ?? '')).toBe(false);
  });

  test('defaults the username rather than leaving it blank', async () => {
    const app = anApp();
    await setAccess(app.id, { password: 'open sesame' });
    expect(accessFor(app.id)?.username).toBe('visitor');
  });

  test('can be taken off again', async () => {
    const app = anApp();
    await setAccess(app.id, { username: 'friend', password: 'open sesame' });
    await setAccess(app.id, { password: null });

    expect(accessFor(app.id)).toBeNull();
    expect(findService(app.id)?.access?.hasPassword).toBe(false);
  });

  test('survives an unrelated change', async () => {
    // Saving the form to flip maintenance on must not silently drop the password.
    const app = anApp();
    await setAccess(app.id, { username: 'friend', password: 'open sesame' });
    await setAccess(app.id, { maintenance: true });

    expect(accessFor(app.id)?.hash).toBeTruthy();
  });
});

describe('what the proxy is told', () => {
  const options = { httpPort: 80, httpsPort: 443 };

  function handlersFor(access: Parameters<typeof synthesizeCaddyConfig>[0][0]['access']) {
    const config = synthesizeCaddyConfig(
      [{ hostname: 'app.example.com', upstream: 'c1', port: 3000, https: true, access }],
      options,
    );
    // Two routes match this host: the http-to-https redirect, and the one that serves
    // it. The second is the one wanted, and during maintenance it has no subroute at
    // all because the app is deliberately not in the chain.
    const routes = (config.apps.http.servers.derailed?.routes ?? []).filter((entry) =>
      entry.match?.some((matcher) => matcher.host?.includes('app.example.com')),
    );
    const serving = routes.find(
      (entry) => (entry.handle[0] as { handler?: string })?.handler !== 'static_response',
    );
    if (!serving) {
      // Maintenance: the whole route is the holding page.
      const holding = routes.find(
        (entry) =>
          (entry.handle[0] as { handler?: string })?.handler === 'static_response' &&
          !entry.match?.some((matcher) => matcher.protocol === 'http'),
      );
      return (holding?.handle ?? []) as { handler?: string; status_code?: number }[];
    }
    const subroute = serving.handle[0] as { routes?: { handle?: unknown[] }[] } | undefined;
    return (subroute?.routes?.[0]?.handle ?? []) as { handler?: string; status_code?: number }[];
  }

  test('proxies straight through when nothing is set', () => {
    const handlers = handlersFor(undefined);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.handler).toBe('reverse_proxy');
  });

  test('puts the password check in front of the app', () => {
    const handlers = handlersFor({ basicAuth: { username: 'friend', hash: '$2a$12$abc' } });
    expect(handlers[0]?.handler).toBe('authentication');
    expect(handlers[1]?.handler).toBe('reverse_proxy');
  });

  test('turns away an address that is not allowed before asking for a password', () => {
    // Order matters: somebody who is not allowed to be here should be refused, not
    // invited to start guessing a password.
    const handlers = handlersFor({
      basicAuth: { username: 'friend', hash: '$2a$12$abc' },
      allowFrom: ['203.0.113.0/24'],
    });
    expect(handlers[0]?.handler).toBe('subroute');
    expect(handlers[1]?.handler).toBe('authentication');
    expect(handlers[2]?.handler).toBe('reverse_proxy');
  });

  test('shows the holding page instead of everything else', () => {
    // During maintenance nobody gets through, whatever else is configured, and the
    // app is not reached at all.
    const handlers = handlersFor({
      maintenance: true,
      basicAuth: { username: 'friend', hash: '$2a$12$abc' },
      allowFrom: ['203.0.113.0/24'],
    });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.handler).toBe('static_response');
    expect(handlers[0]?.status_code).toBe(503);
  });

  test('does not add an empty allowlist as a rule that blocks everyone', () => {
    const handlers = handlersFor({ allowFrom: [] });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.handler).toBe('reverse_proxy');
  });

  test('does not add an empty blocklist either', () => {
    const handlers = handlersFor({ blockFrom: [] });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.handler).toBe('reverse_proxy');
  });

  test('checks the block list before the allow list, so a block wins', () => {
    // Somebody on both lists is not welcome. That is the reading nobody has to think
    // about, and the order is the only place it can be expressed.
    const handlers = handlersFor({
      allowFrom: ['203.0.113.0/24'],
      blockFrom: ['203.0.113.9'],
      basicAuth: { username: 'friend', hash: '$2a$12$abc' },
    });
    expect(handlers.map((entry) => entry.handler)).toEqual([
      'subroute',
      'subroute',
      'authentication',
      'reverse_proxy',
    ]);

    const blocked = handlers[0] as unknown as {
      routes: { match: { remote_ip?: { ranges: string[] }; not?: unknown[] }[] }[];
    };
    // The first one matches the blocked range directly; the allow list is the `not`.
    expect(blocked.routes[0]?.match[0]?.remote_ip?.ranges).toEqual(['203.0.113.9']);
    expect(blocked.routes[0]?.match[0]?.not).toBeUndefined();
  });

  test('the holding page still beats a block list', () => {
    const handlers = handlersFor({ maintenance: true, blockFrom: ['203.0.113.9'] });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.status_code).toBe(503);
  });
});

/**
 * Whether an entry covers a particular address.
 *
 * Only used to warn somebody they are about to block themselves out of their own
 * site, but the arithmetic is the sort that is quietly wrong for a year: a leading
 * octet above 127 makes an unguarded shift go negative.
 */
describe('whether a list entry covers an address', () => {
  test('matches a bare address exactly', () => {
    expect(coversAddress('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(coversAddress('203.0.113.7', '203.0.113.8')).toBe(false);
  });

  test('matches inside a range and not outside it', () => {
    expect(coversAddress('203.0.113.0/24', '203.0.113.7')).toBe(true);
    expect(coversAddress('203.0.113.0/24', '203.0.114.7')).toBe(false);
    expect(coversAddress('10.0.0.0/8', '10.255.255.255')).toBe(true);
    expect(coversAddress('10.0.0.0/8', '11.0.0.1')).toBe(false);
  });

  test('handles addresses above 127, where a signed shift goes wrong', () => {
    expect(coversAddress('192.168.0.0/16', '192.168.44.9')).toBe(true);
    expect(coversAddress('192.168.0.0/16', '192.169.44.9')).toBe(false);
    expect(coversAddress('255.255.255.0/24', '255.255.255.9')).toBe(true);
  });

  test('a zero-length prefix covers everything, and a full one covers only itself', () => {
    expect(coversAddress('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(coversAddress('203.0.113.7/32', '203.0.113.7')).toBe(true);
    expect(coversAddress('203.0.113.7/32', '203.0.113.6')).toBe(false);
  });

  test('compares v6 as text rather than guessing', () => {
    // A missed warning is a warning, not a hole, so this is deliberately not clever.
    expect(coversAddress('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(coversAddress('2001:db8::/32', '2001:db8::1')).toBe(false);
  });
});
