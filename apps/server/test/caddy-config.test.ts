import { describe, expect, test } from 'bun:test';
import {
  generatedHostname,
  isIpBasedHostname,
  type RouteSpec,
  synthesizeCaddyConfig,
} from '../src/proxy/routes.ts';

const OPTIONS = { httpPort: 80, httpsPort: 443 };

const route = (over: Partial<RouteSpec> = {}): RouteSpec => ({
  hostname: 'app.example.com',
  upstream: 'd_demo_web_ab12cd34',
  port: 3000,
  https: true,
  ...over,
});

describe('caddy config synthesis', () => {
  test('is a pure function of its input', () => {
    const routes = [route(), route({ hostname: 'b.example.com' })];
    expect(synthesizeCaddyConfig(routes, OPTIONS)).toEqual(
      synthesizeCaddyConfig([...routes].reverse(), OPTIONS),
    );
  });

  test('answers an unknown hostname with a plain-language 404', () => {
    const config = synthesizeCaddyConfig([route()], OPTIONS);
    const fallback = config.apps.http.servers.derailed!.routes.at(-1)!;
    expect(fallback.match).toBeUndefined();
    expect(JSON.stringify(fallback.handle)).toContain('Nothing is set up at this web address yet');
  });

  test('serves an empty config when nothing is routed', () => {
    const config = synthesizeCaddyConfig([], OPTIONS);
    // Only the "nothing is set up here yet" catch-all.
    expect(config.apps.http.servers.derailed!.routes).toHaveLength(1);
    expect(config.apps.http.servers.derailed!.routes[0]!.match).toBeUndefined();
    expect(config.apps.http.servers.derailed!.listen).toEqual([':80', ':443']);
  });

  test('points a hostname at its container', () => {
    const config = synthesizeCaddyConfig([route()], OPTIONS);
    const proxy = config.apps.http.servers.derailed!.routes.find((r) =>
      JSON.stringify(r.handle).includes('reverse_proxy'),
    )!;
    expect(proxy.match).toEqual([{ host: ['app.example.com'] }]);
    expect(JSON.stringify(proxy.handle)).toContain('d_demo_web_ab12cd34:3000');
    expect(proxy.terminal).toBe(true);
  });

  test('redirects http to https for a secured host', () => {
    // One server handles both ports, so without an explicit redirect an http://
    // request is proxied straight through and the visitor's password crosses the
    // wire in the clear. This was live on a real deployment before it was caught.
    const config = synthesizeCaddyConfig([route({ https: true })], OPTIONS);
    const redirect = config.apps.http.servers.derailed!.routes.find(
      (r) =>
        JSON.stringify(r.handle).includes('static_response') &&
        JSON.stringify(r.handle).includes('308'),
    )!;

    expect(redirect).toBeDefined();
    expect(redirect.match?.[0]?.protocol).toBe('http');
    expect(redirect.match?.[0]?.host).toEqual(['app.example.com']);
    expect(JSON.stringify(redirect.handle)).toContain('https://{http.request.host}');
    // Renewal must not be redirected into a loop ninety days from now.
    expect(JSON.stringify(redirect.match)).toContain('acme-challenge');
  });

  test('does not redirect a plain-HTTP generated hostname', () => {
    const config = synthesizeCaddyConfig(
      [route({ hostname: 'web.203-0-113-7.sslip.io', https: false })],
      OPTIONS,
    );
    expect(JSON.stringify(config)).not.toContain('308');
  });

  test('skips automatic HTTPS for generated hostnames only', () => {
    const config = synthesizeCaddyConfig(
      [
        route({ hostname: 'web.203-0-113-7.sslip.io', https: false }),
        route({ hostname: 'shop.example.com', https: true }),
      ],
      OPTIONS,
    );
    expect(config.apps.http.servers.derailed!.automatic_https.skip).toEqual([
      'web.203-0-113-7.sslip.io',
    ]);
  });

  test('drops duplicate hostnames instead of producing two matching routes', () => {
    const config = synthesizeCaddyConfig(
      [route(), route({ upstream: 'other-container' })],
      OPTIONS,
    );
    const matched = config.apps.http.servers.derailed!.routes.filter((r) => r.match);
    const proxies = matched.filter((r) => JSON.stringify(r.handle).includes('reverse_proxy'));
    expect(proxies).toHaveLength(1);
  });

  test('a dev tunnel strips the caller-supplied trust headers before stamping its own', () => {
    // The dev route hands every path to the panel with a freshly-minted, valid proxy
    // secret, and the panel's public sinks trust `X-Derailed-Service` once the secret
    // checks out. If a visitor's own `X-Derailed-Service` rode through beside that
    // secret, they could post into another tenant's Messages or wave an IP past its bot
    // wall. So the caller's copies must be deleted, exactly as the app route does.
    const config = synthesizeCaddyConfig(
      [
        route({
          hostname: 'sunny-fox-1a2b.apps.example.com',
          panelSecret: 'the-real-secret',
          dev: { sub: 'sunny-fox-1a2b', panelUpstream: '127.0.0.1', panelPort: 8422 },
        }),
      ],
      OPTIONS,
    );
    const devRoute = config.apps.http.servers.derailed!.routes.find((r) =>
      JSON.stringify(r.handle).includes('X-Derailed-Dev'),
    )!;
    const request = (devRoute.handle[0] as { headers: { request: Record<string, unknown> } })
      .headers.request;
    expect(request.delete).toEqual(
      expect.arrayContaining(['X-Derailed-Proxy', 'X-Derailed-Service', 'X-Derailed-User']),
    );
    // The secret it mints is still set, so the panel keeps trusting the route itself.
    expect(JSON.stringify(request.set)).toContain('the-real-secret');
  });

  test('matches the expected shape', () => {
    expect(
      synthesizeCaddyConfig(
        [
          route({ hostname: 'web.203-0-113-7.sslip.io', https: false }),
          route({ hostname: 'shop.example.com', port: 8080 }),
        ],
        OPTIONS,
      ),
    ).toMatchSnapshot();
  });
});

describe('generated hostnames', () => {
  test('encode the server ip with dashes', () => {
    expect(generatedHostname('web', '203.0.113.7')).toBe('web.203-0-113-7.sslip.io');
  });

  test('are recognised as generated', () => {
    expect(isIpBasedHostname('web.203-0-113-7.sslip.io')).toBe(true);
    expect(isIpBasedHostname('shop.example.com')).toBe(false);
  });
});
