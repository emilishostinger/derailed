import { describe, expect, test } from 'bun:test';
import { type RouteSpec, synthesizeCaddyConfig } from '../src/proxy/routes.ts';

/**
 * Pictures the right size, at the level where the bugs would live: the Caddy
 * config. The rewrite interpolates a query value into a URL-shaped path, so the
 * digits-only guard on `w` is load-bearing security, not tidiness: without it,
 * `?w=800/plain/http://169.254.169.254` walks the sidecar to any address an
 * attacker names. These tests pin the guard and the grammar.
 */

const OPTIONS = { httpPort: 80, httpsPort: 443 };

const route = (over: Partial<RouteSpec> = {}): RouteSpec => ({
  hostname: 'shop.example.com',
  upstream: 'd_demo_web_ab12cd34',
  port: 3000,
  https: true,
  ...over,
});

function flat(config: unknown): string {
  return JSON.stringify(config);
}

describe('the /_img route', () => {
  test('exists only when the switch is on', () => {
    const off = flat(synthesizeCaddyConfig([route()], OPTIONS));
    expect(off).not.toContain('/_img');
    const on = flat(synthesizeCaddyConfig([route({ images: true })], OPTIONS));
    expect(on).toContain('/_img/*');
    expect(on).toContain('derailed-images:8080');
  });

  test('the width is matched digits-only before it is interpolated anywhere', () => {
    const config = flat(synthesizeCaddyConfig([route({ images: true })], OPTIONS));
    // The guard itself.
    expect(config).toContain("{http.request.uri.query.w}.matches('^[0-9]{1,4}$')");
    // The interpolation it guards.
    expect(config).toContain(
      '/insecure/w:{http.request.uri.query.w}/plain/http://d_demo_web_ab12cd34:3000{http.request.uri.path}?',
    );
  });

  test('a request without a width is re-encoded, never resized, nothing interpolated', () => {
    const config = flat(synthesizeCaddyConfig([route({ images: true })], OPTIONS));
    expect(config).toContain(
      '/insecure/plain/http://d_demo_web_ab12cd34:3000{http.request.uri.path}?',
    );
  });

  test('the prefix is stripped so the source path is the file itself', () => {
    const config = flat(synthesizeCaddyConfig([route({ images: true })], OPTIONS));
    expect(config).toContain('"strip_path_prefix":"/_img"');
  });

  test('a dev tunnel host proxies to the panel with the marker and the secret', () => {
    const config = synthesizeCaddyConfig(
      [
        {
          hostname: 'sunny-fox.apps.example.com',
          upstream: 'host.docker.internal',
          port: 8422,
          https: true,
          panelSecret: 'shh',
          dev: { sub: 'sunny-fox', panelUpstream: 'host.docker.internal', panelPort: 8422 },
        },
      ],
      OPTIONS,
    );
    const text = flat(config);
    expect(text).toContain('sunny-fox.apps.example.com');
    expect(text).toContain('X-Derailed-Dev');
    expect(text).toContain('host.docker.internal:8422');
    // The secret proves the hop, so the panel can tell a real dev request from a
    // client forging the marker at its open port.
    expect(text).toContain('X-Derailed-Proxy');
  });

  test('pictures sit behind the same access rules as pages', () => {
    // The images subroute must come after the basic-auth handler in the chain: a
    // password-protected site's pictures are exactly as private as its pages.
    const config = synthesizeCaddyConfig(
      [
        route({
          images: true,
          access: { basicAuth: { username: 'v', hash: 'x' } },
        }),
      ],
      OPTIONS,
    );
    const text = flat(config);
    const auth = text.indexOf('authentication');
    const img = text.indexOf('/_img');
    expect(auth).toBeGreaterThan(-1);
    expect(img).toBeGreaterThan(auth);
  });
});
