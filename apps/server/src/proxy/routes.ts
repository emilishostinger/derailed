/**
 * Derailed owns Caddy's entire configuration. This module is a pure function from
 * "what should be reachable" to Caddy JSON. No incremental patching, so the config
 * can never drift, and the whole thing is snapshot-testable without Docker.
 */

export interface RouteSpec {
  hostname: string;
  /** Container name (or any host Caddy can resolve on the shared network). */
  upstream: string;
  port: number;
  /**
   * Set when this name only exists to send people to another one, e.g. www to the
   * apex. It still gets a certificate: a redirect that warns about security first
   * is worse than no redirect at all.
   */
  redirectTo?: string;
  /**
   * Generated sslip.io hostnames are served over plain HTTP on purpose: asking
   * Let's Encrypt for a cert per throwaway hostname burns rate limits fast.
   */
  https: boolean;
}

interface CaddyLog {
  level?: string;
  writer?: { output: string; filename?: string; roll_size_mb?: number; roll_keep?: number };
  encoder?: { format: string };
  include?: string[];
}

export interface CaddyConfig {
  admin: { listen: string; disabled?: boolean };
  logging: { logs: Record<string, CaddyLog> };
  apps: {
    http: {
      servers: Record<string, CaddyServer>;
    };
  };
}

interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
  automatic_https: { skip?: string[]; disable?: boolean };
  /** Turns on the access log for this server, under the logger name below. */
  logs?: Record<string, never>;
}

interface CaddyMatcher {
  host?: string[];
  /** "http" or "https", lets one server treat the two ports differently. */
  protocol?: string;
  not?: { path: string[] }[];
}

interface CaddyRoute {
  match?: CaddyMatcher[];
  handle: unknown[];
  terminal: true;
}

/**
 * Without this, Caddy answers an unrecognised hostname with a blank 200, which reads
 * like "the app is broken". A plain-language 404 tells whoever is pointing DNS here
 * that they reached the right machine but nothing is set up for that name yet.
 */
const FALLBACK_ROUTE: CaddyRoute = {
  handle: [
    {
      handler: 'static_response',
      status_code: 404,
      headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
      body: 'Nothing is set up at this web address yet.\n\nThis server runs Derailed. If you own it, open the dashboard and add this address to one of your apps.\n',
    },
  ],
  terminal: true,
};

export interface SynthesizeOptions {
  httpPort: number;
  httpsPort: number;
  adminListen?: string;
}

export function synthesizeCaddyConfig(
  routes: RouteSpec[],
  options: SynthesizeOptions,
): CaddyConfig {
  // Deterministic ordering keeps snapshots stable and pushes idempotent.
  const sorted = [...routes].sort((a, b) => a.hostname.localeCompare(b.hostname));
  const seen = new Set<string>();
  const unique = sorted.filter((route) => {
    if (seen.has(route.hostname)) return false;
    seen.add(route.hostname);
    return true;
  });

  const skip = unique.filter((route) => !route.https).map((route) => route.hostname);

  return {
    admin: { listen: options.adminListen ?? '0.0.0.0:2019' },
    logging: {
      logs: {
        // Errors to the container log, one JSON line per request to a file Derailed
        // reads. Nothing about a visitor is kept beyond the figures it adds up to.
        default: { level: 'ERROR' },
        access: {
          level: 'INFO',
          // Caddy names this logger `http.log.access`, not `http.log.access.<server>`
          // as the docs imply. Checked against a running instance; the more specific
          // name matches nothing and the file stays empty with no error anywhere.
          include: ['http.log.access'],
          writer: {
            output: 'file',
            filename: '/logs/access.log',
            roll_size_mb: 8,
            roll_keep: 1,
          },
          encoder: { format: 'json' },
        },
      },
    },
    apps: {
      http: {
        servers: {
          derailed: {
            listen: [`:${options.httpPort}`, `:${options.httpsPort}`],
            // Redirects first: one server handles both ports, so without these an
            // http:// request to a secured host would be proxied straight through and
            // the visitor's password would cross the wire in the clear.
            routes: [
              ...unique.filter((route) => route.https).map(redirectToHttps),
              ...unique.map(routeFor),
              FALLBACK_ROUTE,
            ],
            automatic_https: skip.length ? { skip } : {},
            logs: {},
          },
        },
      },
    },
  };
}

/**
 * Sends http:// to https:// for a host that has a certificate.
 *
 * The ACME challenge path is excluded: Caddy installs its own challenge handler ahead
 * of these routes, but a terminal catch-all redirect on port 80 is exactly the kind of
 * thing that quietly breaks certificate renewal ninety days later.
 */
function redirectToHttps(route: RouteSpec): CaddyRoute {
  return {
    match: [
      {
        host: [route.hostname],
        protocol: 'http',
        not: [{ path: ['/.well-known/acme-challenge/*'] }],
      },
    ],
    handle: [
      {
        handler: 'static_response',
        status_code: 308,
        headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
      },
    ],
    terminal: true,
  };
}

function routeFor(route: RouteSpec): CaddyRoute {
  if (route.redirectTo) {
    return {
      match: [{ host: [route.hostname], not: [{ path: ['/.well-known/acme-challenge/*'] }] }],
      handle: [
        {
          handler: 'static_response',
          status_code: 308,
          headers: {
            Location: [`https://${route.redirectTo}{http.request.uri}`],
          },
        },
      ],
      terminal: true,
    };
  }

  return {
    match: [{ host: [route.hostname] }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: [
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: `${route.upstream}:${route.port}` }],
                headers: {
                  request: {
                    set: {
                      'X-Forwarded-Host': ['{http.request.host}'],
                      'X-Forwarded-Proto': ['{http.request.scheme}'],
                    },
                  },
                },
                health_checks: {
                  passive: { fail_duration: '10s', max_fails: 3 },
                },
              },
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
}

/**
 * The address every app gets for free.
 *
 * With a base domain set, that is `myapp.apps.example.com`, which can hold a real
 * certificate. Without one it is `myapp.203-0-113-7.sslip.io`: a working URL with no
 * DNS setup at all, and plain HTTP, for the reason in `isIpBasedHostname`.
 */
export function generatedHostname(
  serviceSlug: string,
  serverIp: string,
  baseDomain?: string | null,
): string {
  if (baseDomain) return `${serviceSlug}.${baseDomain}`;
  return `${serviceSlug}.${serverIp.replace(/\./g, '-')}.sslip.io`;
}

/**
 * Addresses that spell out an IP address, like sslip.io and nip.io.
 *
 * These cannot be secured. Neither is on the public suffix list, so as far as Let's
 * Encrypt is concerned every sslip.io address in the world shares one allowance of
 * fifty certificates a week. Asking for one would usually fail, and would take that
 * allowance from someone else when it worked.
 */
export function isIpBasedHostname(hostname: string): boolean {
  return hostname.endsWith('.sslip.io') || hostname.endsWith('.nip.io');
}
