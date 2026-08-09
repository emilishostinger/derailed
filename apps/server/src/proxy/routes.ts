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
  /**
   * Set when Derailed already holds the certificate for this name, which today means
   * it falls under the free address's wildcard. Caddy is told not to go looking for
   * one of its own: it would ask over HTTP, fail on a name it cannot prove that way,
   * and retry until the allowance for the whole domain was gone.
   */
  providedCert?: boolean;
  /** Who is allowed to see this, and whether it is showing a holding page instead. */
  access?: AccessSpec;
  /**
   * When several apps share one domain, the path this one answers on: `/blog`.
   * Absent means the whole domain, which is what almost every route is.
   */
  pathPrefix?: string | null;
  /**
   * Set when this app's form posts are caught by Derailed. The POST a static
   * site could never answer is sent back to the panel instead, carrying which
   * service it belongs to, and becomes a message.
   */
  forms?: { serviceId: string; panelUpstream: string; panelPort: number } | null;
  /**
   * Set when visitors sign in with their Derailed account before seeing this
   * app. Caddy asks the panel about every request; a yes carries on to the app,
   * anything else is the login page, on the app's own address.
   */
  login?: { serviceId: string; panelUpstream: string; panelPort: number } | null;
  /**
   * The secret that proves a request reached the panel through this proxy. It is
   * stamped on every internal route below that reaches a public endpoint, so a
   * request straight to the panel's open port cannot forge one.
   */
  panelSecret?: string;
  /**
   * Set when `/_img/…?w=…` answers with the picture resized. Caddy rewrites the
   * request into the imgproxy sidecar's grammar and dials it over the shared
   * network; the sidecar fetches the original from this app's own container.
   */
  images?: boolean;
  /**
   * Set when this whole hostname is a laptop's dev tunnel. Every request is handed
   * to the panel, stamped with the subdomain and the proxy secret, and the panel
   * forwards it down the control socket to the laptop.
   */
  dev?: { sub: string; panelUpstream: string; panelPort: number } | null;
  /**
   * The walls against automated traffic: named AI crawlers turned away, and the
   * addresses currently challenged or refused for going too hard. All enforced
   * by Caddy from this config; Derailed stays out of the request path.
   */
  bots?: {
    serviceId: string;
    blockAi: boolean;
    challenged: string[];
    banned: string[];
    panelUpstream: string;
    panelPort: number;
  } | null;
}

/**
 * The crawlers that read sites to feed models, by the names they announce.
 * A scraper that lies about its name walks past this list; the rate walls below
 * are for those. Matched as substrings, case-insensitively, by Caddy itself.
 */
export const AI_CRAWLERS = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-Web',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'Google-Extended',
  'PerplexityBot',
  'Perplexity-User',
  'CCBot',
  'Bytespider',
  'Amazonbot',
  'FacebookBot',
  'meta-externalagent',
  'Meta-ExternalAgent',
  'Applebot-Extended',
  'cohere-ai',
  'cohere-training-data-crawler',
  'Diffbot',
  'ImagesiftBot',
  'omgili',
  'Timpibot',
  'YouBot',
  'AI2Bot',
  'PanguBot',
  'Kangaroo Bot',
  'SemrushBot-OCOB',
];

/** What `/robots.txt` says when the toggle is on: the same list, politely. */
export function aiRobotsTxt(): string {
  const lines = AI_CRAWLERS.flatMap((name) => [`User-agent: ${name}`, 'Disallow: /', '']);
  return `${lines.join('\n')}User-agent: *\nAllow: /\n`;
}

/**
 * Restrictions on who gets to see an app.
 *
 * All of it is enforced by the proxy rather than by the app, which is the entire
 * point: it works for WordPress, for a folder of HTML, and for something written in a
 * language nobody here has heard of, without any of them being changed.
 */
export interface AccessSpec {
  /** A username and a bcrypt hash. Caddy checks it; Derailed never sees the password again. */
  basicAuth?: { username: string; hash: string } | null;
  /** Addresses and CIDR ranges. Anything not in the list gets a plain refusal. */
  allowFrom?: string[] | null;
  /**
   * Addresses and CIDR ranges turned away outright.
   *
   * The opposite question from `allowFrom`, and the one people actually arrive with:
   * one address hammering the login page, one bot ignoring robots.txt. An allow list
   * cannot express that without naming every visitor you have ever had.
   */
  blockFrom?: string[] | null;
  /** Shows a holding page to everyone, whatever else is set. */
  maintenance?: boolean;
}

/** A certificate Derailed obtained, by the paths Caddy will see inside its container. */
export interface LoadedCertificate {
  certificate: string;
  key: string;
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
    /** Only present when Derailed is supplying a certificate of its own. */
    tls?: { certificates: { load_files: LoadedCertificate[] } };
  };
}

interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
  /**
   * `skip` opts a name out of HTTPS altogether. `skip_certificates` keeps the HTTPS
   * listener and the redirect but stops Caddy trying to obtain anything, which is what
   * a name covered by a certificate we already hold needs.
   */
  automatic_https: { skip?: string[]; skip_certificates?: string[]; disable?: boolean };
  /** Turns on the access log for this server, under the logger name below. */
  logs?: Record<string, never>;
}

interface CaddyMatcher {
  host?: string[];
  path?: string[];
  method?: string[];
  /** Header values, `*` wildcards included; how the crawler list is matched. */
  header?: Record<string, string[]>;
  /** "http" or "https", lets one server treat the two ports differently. */
  protocol?: string;
  not?: ({ path: string[] } | { remote_ip: { ranges: string[] } })[];
  remote_ip?: { ranges: string[] };
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
  /** Certificates Derailed obtained itself, by their path inside Caddy's container. */
  certificates?: LoadedCertificate[];
}

export function synthesizeCaddyConfig(
  routes: RouteSpec[],
  options: SynthesizeOptions,
): CaddyConfig {
  // Deterministic ordering keeps snapshots stable and pushes idempotent. Within one
  // hostname the longest path comes first, because Caddy takes the first route that
  // matches and `/` would otherwise swallow `/blog` before it was ever reached.
  const sorted = [...routes].sort(
    (a, b) =>
      a.hostname.localeCompare(b.hostname) ||
      (b.pathPrefix ?? '').length - (a.pathPrefix ?? '').length,
  );

  // One entry per hostname *and* path: several apps may share a domain now.
  const seen = new Set<string>();
  const unique = sorted.filter((route) => {
    const key = `${route.hostname}${route.pathPrefix ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // These are properties of a *name*, not of a route, so they are deduplicated even
  // though several routes may now share one hostname.
  const skip = [...new Set(unique.filter((r) => !r.https).map((r) => r.hostname))];
  const skipCertificates = [
    ...new Set(unique.filter((r) => r.https && r.providedCert).map((r) => r.hostname)),
  ];
  const certificates = options.certificates ?? [];

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
      ...(certificates.length ? { tls: { certificates: { load_files: certificates } } } : {}),
      http: {
        servers: {
          derailed: {
            listen: [`:${options.httpPort}`, `:${options.httpsPort}`],
            // Redirects first: one server handles both ports, so without these an
            // http:// request to a secured host would be proxied straight through and
            // the visitor's password would cross the wire in the clear.
            routes: [
              // One redirect per secured name, not per route: two apps on one domain
              // would otherwise emit two identical redirects.
              ...dedupeByHost(unique.filter((route) => route.https)).map(redirectToHttps),
              ...unique.map(routeFor),
              FALLBACK_ROUTE,
            ],
            automatic_https: {
              ...(skip.length ? { skip } : {}),
              ...(skipCertificates.length ? { skip_certificates: skipCertificates } : {}),
            },
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

/**
 * The page visitors see while an app is deliberately not serving.
 *
 * 503 rather than 200, so a search engine that comes past treats it as temporary and
 * does not replace the real page with this one in its index.
 */
const MAINTENANCE_BODY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Back shortly</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;color:#1c1b22;background:#faf9fb;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{max-width:26rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#5b5a66}
  @media(prefers-color-scheme:dark){body{color:#eceaf2;background:#131218}p{color:#a6a3b3}}
</style></head>
<body><main><h1>Back shortly</h1>
<p>This site is having a little work done. Please try again in a few minutes.</p>
</main></body></html>`;

/**
 * Turns a request away, plainly.
 *
 * The same refusal for both lists on purpose. Saying "you are blocked" rather than
 * "this is restricted" tells whoever is on the wrong end which of the two lists they
 * are on, and the only person that helps is the one you meant to keep out.
 */
function refuse(match: unknown): unknown {
  return {
    handler: 'subroute',
    routes: [
      {
        match: [match],
        handle: [
          {
            handler: 'static_response',
            status_code: 403,
            headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
            body: 'This site is only available from certain addresses.\n',
          },
        ],
        terminal: true,
      },
    ],
  };
}

/**
 * The handlers that run before the app sees a request.
 *
 * Order matters and is deliberate. The holding page comes first, because during
 * maintenance nobody should get through whatever else is configured. Then the block
 * list, so an explicit refusal wins over an explicit invitation. Then the allow list.
 * The password comes last, so somebody who is not allowed to be here at all is turned
 * away without being invited to guess one.
 */
function accessHandlers(access: AccessSpec | undefined): unknown[] {
  if (!access) return [];
  const handlers: unknown[] = [];

  if (access.maintenance) {
    handlers.push({
      handler: 'static_response',
      status_code: 503,
      headers: {
        'Content-Type': ['text/html; charset=utf-8'],
        // Explicitly uncached: a holding page kept by a CDN or a browser outlives the
        // maintenance it was announcing, and then the site is "down" for people whose
        // cache still has it.
        'Cache-Control': ['no-store'],
        'Retry-After': ['600'],
      },
      body: MAINTENANCE_BODY,
    });
    return handlers;
  }

  // Before the allow list, so an explicit block wins over an explicit invitation.
  // That is the reading that never surprises anybody: a name on the "not welcome"
  // list is not welcome, whatever else it is also on.
  if (access.blockFrom?.length) {
    handlers.push(refuse({ remote_ip: { ranges: access.blockFrom } }));
  }

  if (access.allowFrom?.length) {
    handlers.push(refuse({ not: [{ remote_ip: { ranges: access.allowFrom } }] }));
  }

  if (access.basicAuth) {
    handlers.push({
      handler: 'authentication',
      providers: {
        http_basic: {
          // Named so the browser's own prompt says something, since that dialog is
          // the entire interface for this and Derailed cannot style it.
          realm: 'This site is private',
          accounts: [{ username: access.basicAuth.username, password: access.basicAuth.hash }],
        },
      },
    });
  }

  return handlers;
}

/**
 * What a request has to look like to reach this route.
 *
 * A path prefix matches the prefix itself and everything under it, so `/blog` catches
 * `/blog` and `/blog/anything` but not `/blogging`.
 */
function matcherFor(route: RouteSpec): CaddyMatcher {
  if (!route.pathPrefix) return { host: [route.hostname] };
  const prefix = route.pathPrefix.replace(/\/+$/, '');
  return { host: [route.hostname], path: [prefix, `${prefix}/*`] };
}

/** One entry per hostname, keeping the first. */
function dedupeByHost(routes: RouteSpec[]): RouteSpec[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    if (seen.has(route.hostname)) return false;
    seen.add(route.hostname);
    return true;
  });
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

  // A dev tunnel is the whole host: hand every request to the panel, stamped with
  // the subdomain it is for and the proxy secret that proves it came this way, and
  // the panel forwards it to the laptop. The app the panel serves is not reached;
  // only the dev-forward path is.
  if (route.dev) {
    return {
      match: [{ host: [route.hostname] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: `${route.dev.panelUpstream}:${route.dev.panelPort}` }],
          headers: {
            request: {
              set: {
                'X-Derailed-Dev': [route.dev.sub],
                'X-Forwarded-For': ['{http.request.remote.host}'],
                ...(route.panelSecret ? { 'X-Derailed-Proxy': [route.panelSecret] } : {}),
              },
            },
          },
        },
      ],
      terminal: true,
    };
  }

  // During maintenance the app is left out of the chain entirely rather than sitting
  // behind a handler that happens to stop before reaching it. Caddy would not call it,
  // but "the app is not reached" is worth being structurally true rather than a
  // property of how the proxy chains handlers.
  if (route.access?.maintenance) {
    return {
      match: [matcherFor(route)],
      handle: accessHandlers(route.access),
      terminal: true,
    };
  }

  const proxyToApp = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `${route.upstream}:${route.port}` }],
    headers: {
      request: {
        set: {
          'X-Forwarded-Host': ['{http.request.host}'],
          'X-Forwarded-Proto': ['{http.request.scheme}'],
        },
        // The app must never receive the headers Derailed uses to vouch for a
        // request: a visitor who sends `X-Derailed-User: owner@example.com`
        // would otherwise reach an app that trusts it.
        delete: [
          'X-Derailed-Proxy',
          'X-Derailed-Service',
          'X-Derailed-User',
          'X-Derailed-Form-Host',
        ],
      },
    },
    health_checks: {
      passive: { fail_duration: '10s', max_fails: 3 },
    },
  };

  return {
    match: [matcherFor(route)],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: [
              // The bot walls come first: an address being refused for hammering
              // should not be offered a password prompt to hammer instead.
              ...(route.bots ? botHandlers(route.bots, route.panelSecret) : []),
              // Then the sign-in, when this app asks people to have one.
              ...(route.login ? loginHandlers(route.login, route.panelSecret) : []),
              // Access next, then forms, then the app: a password-protected
              // site's forms are exactly as private as its pages. Pictures sit
              // inside the same order, so a private site's pictures are exactly
              // as private as its pages too.
              ...accessHandlers(route.access),
              ...(() => {
                const tail = route.forms
                  ? [
                      {
                        handler: 'subroute',
                        routes: [
                          formsRoute(route.forms, route.panelSecret),
                          { handle: [proxyToApp] },
                        ],
                      },
                    ]
                  : [proxyToApp];
                return route.images
                  ? [
                      {
                        handler: 'subroute',
                        routes: [...imageRoutes(route), { handle: tail }],
                      },
                    ]
                  : tail;
              })(),
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
}

/**
 * The page a challenged address sees: a small proof of work a person's browser
 * solves invisibly in under a second and a scraper has to pay for, per address.
 * Self-contained on purpose; it is served by Caddy with nothing behind it.
 */
const CHALLENGE_BODY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>One moment</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;color:#1c1b22;background:#faf9fb;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{max-width:26rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#5b5a66}
  @media(prefers-color-scheme:dark){body{color:#eceaf2;background:#131218}p{color:#a6a3b3}}
</style></head>
<body><main><h1>One moment</h1>
<p>This site is checking that you are visiting with a browser. It takes about a second
and happens by itself.</p>
<noscript><p><b>JavaScript is off</b>, so the check cannot run. Turn it on for this
site, or come back a little later.</p></noscript>
<script>
(async () => {
  try {
    const issued = await fetch('/__derailed/challenge', { headers: { accept: 'application/json' } });
    const { token, prefix } = await issued.json();
    const encoder = new TextEncoder();
    let nonce = 0;
    for (;;) {
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token + nonce));
      const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hex.startsWith(prefix)) break;
      nonce++;
    }
    await fetch('/__derailed/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, nonce: String(nonce) }),
    });
    location.reload();
  } catch {
    setTimeout(() => location.reload(), 4000);
  }
})();
</script>
</main></body></html>`;

/**
 * The walls, in the order they should be met: an outright refusal for the
 * addresses plainly running a script, the proof-of-work for the merely
 * suspicious, and the named AI crawlers turned away with their robots.txt.
 */
function botHandlers(bots: NonNullable<RouteSpec['bots']>, secret?: string): unknown[] {
  const handlers: unknown[] = [];

  if (bots.banned.length) {
    handlers.push({
      handler: 'subroute',
      routes: [
        {
          match: [{ remote_ip: { ranges: bots.banned } }],
          handle: [
            {
              handler: 'static_response',
              status_code: 429,
              headers: {
                'Content-Type': ['text/plain; charset=utf-8'],
                'Retry-After': ['1800'],
              },
              body: 'This address has been asking far too fast. Come back in half an hour.\n',
            },
          ],
          terminal: true,
        },
      ],
    });
  }

  if (bots.challenged.length) {
    handlers.push({
      handler: 'subroute',
      routes: [
        {
          match: [{ remote_ip: { ranges: bots.challenged } }],
          handle: [
            {
              handler: 'subroute',
              routes: [
                // The two challenge endpoints reach the panel; everything else
                // is the page that solves them.
                {
                  match: [{ path: ['/__derailed/challenge'] }],
                  handle: [
                    { handler: 'rewrite', uri: '/api/public/challenge' },
                    {
                      handler: 'reverse_proxy',
                      upstreams: [{ dial: `${bots.panelUpstream}:${bots.panelPort}` }],
                      headers: {
                        request: {
                          set: {
                            'X-Derailed-Service': [bots.serviceId],
                            'X-Forwarded-For': ['{http.request.remote.host}'],
                            ...(secret ? { 'X-Derailed-Proxy': [secret] } : {}),
                          },
                        },
                      },
                    },
                  ],
                  terminal: true,
                },
                {
                  handle: [
                    {
                      handler: 'static_response',
                      status_code: 503,
                      headers: {
                        'Content-Type': ['text/html; charset=utf-8'],
                        'Cache-Control': ['no-store'],
                        'Retry-After': ['5'],
                      },
                      body: CHALLENGE_BODY,
                    },
                  ],
                  terminal: true,
                },
              ],
            },
          ],
          terminal: true,
        },
      ],
    });
  }

  if (bots.blockAi) {
    handlers.push({
      handler: 'subroute',
      routes: [
        {
          match: [{ path: ['/robots.txt'] }],
          handle: [
            {
              handler: 'static_response',
              status_code: 200,
              headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
              body: aiRobotsTxt(),
            },
          ],
          terminal: true,
        },
        {
          match: [{ header: { 'User-Agent': AI_CRAWLERS.map((name) => `*${name}*`) } }],
          handle: [
            {
              handler: 'static_response',
              status_code: 403,
              headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
              body: 'This site does not serve automated crawlers.\n',
            },
          ],
          terminal: true,
        },
      ],
    });
  }

  return handlers;
}

/**
 * Derailed accounts in front of the app: the two handlers that make it real.
 *
 * The first serves the sign-in machinery on the app's own address, so the
 * cookie a login earns belongs to that domain and no other. The second is the
 * question asked before every other request: Caddy calls the panel's check
 * endpoint, carries on to the app when the answer is 200, and otherwise shows
 * the visitor whatever the panel answered, which is how the login page appears
 * without the app being touched.
 */
function loginHandlers(
  login: {
    serviceId: string;
    panelUpstream: string;
    panelPort: number;
  },
  secret?: string,
): unknown[] {
  const identity = {
    'X-Derailed-Service': [login.serviceId],
    'X-Forwarded-For': ['{http.request.remote.host}'],
    'X-Forwarded-Proto': ['{http.request.scheme}'],
    ...(secret ? { 'X-Derailed-Proxy': [secret] } : {}),
  };
  return [
    {
      handler: 'subroute',
      routes: [
        {
          match: [{ path: ['/__derailed/auth/login'] }],
          handle: [
            { handler: 'rewrite', uri: '/api/public/appauth/login?{http.request.uri.query}' },
            {
              handler: 'reverse_proxy',
              upstreams: [{ dial: `${login.panelUpstream}:${login.panelPort}` }],
              headers: { request: { set: identity } },
            },
          ],
          terminal: true,
        },
        {
          match: [{ path: ['/__derailed/auth/logout'] }],
          handle: [
            { handler: 'rewrite', uri: '/api/public/appauth/logout' },
            {
              handler: 'reverse_proxy',
              upstreams: [{ dial: `${login.panelUpstream}:${login.panelPort}` }],
              headers: { request: { set: identity } },
            },
          ],
          terminal: true,
        },
      ],
    },
    {
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${login.panelUpstream}:${login.panelPort}` }],
      rewrite: { method: 'GET', uri: '/api/public/appauth/check' },
      headers: {
        request: {
          set: {
            ...identity,
            'X-Forwarded-Method': ['{http.request.method}'],
            'X-Forwarded-Uri': ['{http.request.uri}'],
          },
        },
      },
      handle_response: [
        {
          match: { status_code: [2] },
          routes: [],
        },
      ],
    },
  ];
}

/**
 * The POST a static site could never answer, turned into a message.
 *
 * Every POST on the app, not a magic path: a form with no `action` posts to the
 * page it is on, which is exactly what the drag-in-a-folder markup does. The
 * request is rewritten to the panel's public form endpoint with the service's
 * identity attached, so the handler knows whose Messages tab it belongs on.
 */
/** Where the picture sidecar answers on the shared network. */
const IMAGES_UPSTREAM = 'derailed-images:8080';

/**
 * `/_img/photo.jpg?w=800`, rewritten into imgproxy's grammar and dialled.
 *
 * The width is matched with a digits-only expression BEFORE it is interpolated
 * into the rewritten path. That order is load-bearing: the rewrite target is a
 * path in a URL-shaped grammar, and a `w` of `800/plain/http://169.254.169.254`
 * would otherwise walk the sidecar to any address an attacker liked. A width
 * that is not one to four digits falls through to the un-resized route, which
 * interpolates nothing.
 */
export function imageRoutes(route: RouteSpec) {
  const source = `http://${route.upstream}:${route.port}`;
  const toSidecar = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: IMAGES_UPSTREAM }],
  };
  return [
    {
      match: [
        {
          path: ['/_img/*'],
          expression: `{http.request.uri.query.w}.matches('^[0-9]{1,4}$')`,
        },
      ],
      handle: [
        { handler: 'rewrite', strip_path_prefix: '/_img' },
        {
          handler: 'rewrite',
          // The trailing ? drops the original query: the sidecar's source URL is
          // the file itself, and ?w=800 is our grammar, not the app's.
          uri: `/insecure/w:{http.request.uri.query.w}/plain/${source}{http.request.uri.path}?`,
        },
        toSidecar,
      ],
    },
    {
      // No width, or not a believable one: still re-encoded (WebP for browsers
      // that take it), never resized, and nothing typed reaches the rewrite.
      match: [{ path: ['/_img/*'] }],
      handle: [
        { handler: 'rewrite', strip_path_prefix: '/_img' },
        {
          handler: 'rewrite',
          uri: `/insecure/plain/${source}{http.request.uri.path}?`,
        },
        toSidecar,
      ],
    },
  ];
}

function formsRoute(
  forms: {
    serviceId: string;
    panelUpstream: string;
    panelPort: number;
  },
  secret?: string,
): unknown {
  return {
    match: [{ method: ['POST'] }],
    handle: [
      { handler: 'rewrite', uri: '/api/public/form' },
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${forms.panelUpstream}:${forms.panelPort}` }],
        headers: {
          request: {
            set: {
              'X-Derailed-Service': [forms.serviceId],
              'X-Forwarded-For': ['{http.request.remote.host}'],
              ...(secret ? { 'X-Derailed-Proxy': [secret] } : {}),
            },
          },
        },
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
