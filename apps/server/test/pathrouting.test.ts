import { describe, expect, test } from 'bun:test';
import { synthesizeCaddyConfig } from '../src/proxy/routes.ts';

/**
 * One domain, several apps.
 *
 * Nobody thinks in "reverse proxy rules"; everybody thinks "I want my blog at /blog".
 * The thing that has to be right is the order: the proxy takes the first route that
 * matches, so a rule for `/` placed before `/blog` swallows the blog entirely and the
 * symptom is a page that is simply the wrong site.
 */

const options = { httpPort: 80, httpsPort: 443 };

function routesFor(specs: Parameters<typeof synthesizeCaddyConfig>[0]) {
  const config = synthesizeCaddyConfig(specs, options);
  return (config.apps.http.servers.derailed?.routes ?? [])
    .filter((route) => route.handle.some((h) => (h as { handler?: string }).handler === 'subroute'))
    .map((route) => {
      const matcher = route.match?.[0] ?? {};
      const subroute = route.handle[0] as { routes?: { handle?: { upstreams?: unknown }[] }[] };
      const proxy = subroute.routes?.[0]?.handle?.[0] as
        | { upstreams?: { dial?: string }[] }
        | undefined;
      return {
        host: matcher.host?.[0],
        path: matcher.path,
        upstream: proxy?.upstreams?.[0]?.dial,
      };
    });
}

describe('several apps on one domain', () => {
  test('puts the longest path first, so it is not swallowed', () => {
    // Given in the worst order on purpose: the bare domain first.
    const routes = routesFor([
      { hostname: 'example.com', upstream: 'site', port: 80, https: true },
      { hostname: 'example.com', upstream: 'blog', port: 80, https: true, pathPrefix: '/blog' },
      { hostname: 'example.com', upstream: 'api', port: 80, https: true, pathPrefix: '/api/v2' },
    ]);

    expect(routes.map((route) => route.upstream)).toEqual(['api:80', 'blog:80', 'site:80']);
  });

  test('matches the prefix itself and everything under it, and nothing else', () => {
    const routes = routesFor([
      { hostname: 'example.com', upstream: 'blog', port: 80, https: true, pathPrefix: '/blog' },
    ]);
    // `/blog` and `/blog/anything`, but deliberately not `/blogging`.
    expect(routes[0]?.path).toEqual(['/blog', '/blog/*']);
  });

  test('tolerates a trailing slash in what was typed', () => {
    const routes = routesFor([
      { hostname: 'example.com', upstream: 'blog', port: 80, https: true, pathPrefix: '/blog/' },
    ]);
    expect(routes[0]?.path).toEqual(['/blog', '/blog/*']);
  });

  test('leaves a whole-domain route with no path matcher at all', () => {
    const routes = routesFor([
      { hostname: 'example.com', upstream: 'site', port: 80, https: true },
    ]);
    expect(routes[0]?.path).toBeUndefined();
  });

  test('keeps different hosts separate', () => {
    const routes = routesFor([
      { hostname: 'a.example.com', upstream: 'one', port: 80, https: true },
      { hostname: 'b.example.com', upstream: 'two', port: 80, https: true },
    ]);
    expect(routes).toHaveLength(2);
  });

  test('still drops a genuine duplicate', () => {
    const routes = routesFor([
      { hostname: 'example.com', upstream: 'first', port: 80, https: true, pathPrefix: '/blog' },
      { hostname: 'example.com', upstream: 'second', port: 80, https: true, pathPrefix: '/blog' },
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.upstream).toBe('first:80');
  });
});

describe('the things that belong to a name rather than a route', () => {
  test('emits one http-to-https redirect per domain, not per app on it', () => {
    const config = synthesizeCaddyConfig(
      [
        { hostname: 'example.com', upstream: 'site', port: 80, https: true },
        { hostname: 'example.com', upstream: 'blog', port: 80, https: true, pathPrefix: '/blog' },
      ],
      options,
    );
    const redirects = (config.apps.http.servers.derailed?.routes ?? []).filter((route) =>
      route.match?.some((matcher) => matcher.protocol === 'http'),
    );
    expect(redirects).toHaveLength(1);
  });

  test('names a certificate to skip once, however many apps share the domain', () => {
    const config = synthesizeCaddyConfig(
      [
        { hostname: 'a.duckdns.org', upstream: 'x', port: 80, https: true, providedCert: true },
        {
          hostname: 'a.duckdns.org',
          upstream: 'y',
          port: 80,
          https: true,
          providedCert: true,
          pathPrefix: '/api',
        },
      ],
      options,
    );
    expect(config.apps.http.servers.derailed?.automatic_https.skip_certificates).toEqual([
      'a.duckdns.org',
    ]);
  });
});
