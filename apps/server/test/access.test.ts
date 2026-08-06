import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { accessFor, createAppService, findService, setAccess } from '../src/db/repo/services.ts';
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
});
