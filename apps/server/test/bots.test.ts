import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrafficEvent } from '../src/analytics/store.ts';
import { isBot, recordTraffic, trafficFor } from '../src/analytics/store.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, updateService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { proxySecret } from '../src/http/proxytrust.ts';
import {
  CHALLENGE_THRESHOLD,
  grantPass,
  issueChallenge,
  observeTraffic,
  resetBotGuard,
  solveChallenge,
  sweepBotGuard,
  verifyChallenge,
  wallsFor,
} from '../src/proxy/botguard.ts';
import {
  AI_CRAWLERS,
  aiRobotsTxt,
  type RouteSpec,
  synthesizeCaddyConfig,
} from '../src/proxy/routes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The bots, blocked. The state machine that raises and lowers the walls, the
 * proof of work a browser solves invisibly, and the Caddy config that enforces
 * all of it without Derailed in the request path.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-bots-'));
let app: ReturnType<typeof createApp>;
let cookie = '';
let siteId = '';

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

  const project = createProject('Guarded');
  siteId = createAppService({
    projectId: project.id,
    name: 'blog',
    source: 'upload',
    repoUrl: null,
    branch: null,
  }).id;
  updateService(siteId, { botMode: 'strict' });
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  resetBotGuard();
});

/** N requests from one address inside one minute, as the collector would see them. */
function burst(ip: string, count: number, at = Date.now()): TrafficEvent[] {
  const minute = Math.floor(at / 60_000) * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    serviceId: siteId,
    at: minute + Math.min(i, 59_000),
    status: 200,
    bytes: 100,
    ms: 5,
    path: `/page-${i}`,
    referrer: '',
    userAgent: 'definitely-a-browser',
    ip,
  }));
}

const strict = () => 'strict' as const;

describe('when the walls go up', () => {
  test('an ordinary visitor never meets one', () => {
    const changed = observeTraffic(burst('203.0.113.5', 30), strict);
    expect(changed).toBe(false);
    expect(wallsFor(siteId).challenged).toEqual([]);
  });

  test('going too hard earns the challenge; five times harder earns the door', () => {
    const limit = CHALLENGE_THRESHOLD.strict;
    expect(observeTraffic(burst('203.0.113.6', limit + 1), strict)).toBe(true);
    expect(wallsFor(siteId).challenged).toEqual(['203.0.113.6']);
    expect(wallsFor(siteId).banned).toEqual([]);

    expect(observeTraffic(burst('203.0.113.7', limit * 5 + 1), strict)).toBe(true);
    expect(wallsFor(siteId).banned).toEqual(['203.0.113.7']);
  });

  test('polite asks much more of an address than strict does', () => {
    const polite = () => 'polite' as const;
    observeTraffic(burst('203.0.113.8', CHALLENGE_THRESHOLD.strict + 1), polite);
    expect(wallsFor(siteId).challenged).toEqual([]);
    observeTraffic(burst('203.0.113.8', CHALLENGE_THRESHOLD.polite + 1), polite);
    expect(wallsFor(siteId).challenged).toEqual(['203.0.113.8']);
  });

  test('the machine itself is never challenged', () => {
    observeTraffic(burst('127.0.0.1', 10_000), strict);
    observeTraffic(burst('172.17.0.1', 10_000), strict);
    expect(wallsFor(siteId).challenged).toEqual([]);
    expect(wallsFor(siteId).banned).toEqual([]);
  });

  test('a wall comes down on its own once its time is up', () => {
    const now = Date.now();
    observeTraffic(burst('203.0.113.9', CHALLENGE_THRESHOLD.strict + 1, now), strict, now);
    expect(wallsFor(siteId, now).challenged).toEqual(['203.0.113.9']);
    const later = now + 2 * 60 * 60 * 1000;
    expect(wallsFor(siteId, later).challenged).toEqual([]);
    sweepBotGuard(later);
  });

  test('a solved challenge is a pass, and the pass holds under more traffic', () => {
    const now = Date.now();
    observeTraffic(burst('203.0.113.10', CHALLENGE_THRESHOLD.strict + 1, now), strict, now);
    grantPass(siteId, '203.0.113.10', now);
    expect(wallsFor(siteId, now).challenged).toEqual([]);
    observeTraffic(
      burst('203.0.113.10', CHALLENGE_THRESHOLD.strict + 1, now + 60_000),
      strict,
      now + 60_000,
    );
    expect(wallsFor(siteId, now + 60_000).challenged).toEqual([]);
  });
});

describe('the proof of work', () => {
  test('a solved challenge verifies; every kind of tampering does not', () => {
    const token = issueChallenge(siteId, '203.0.113.20');
    const nonce = solveChallenge(token);
    expect(verifyChallenge(token, nonce, siteId, '203.0.113.20')).toBe(true);

    // Somebody else's address, a different app, a wrong answer, a forged token.
    expect(verifyChallenge(token, nonce, siteId, '203.0.113.21')).toBe(false);
    expect(verifyChallenge(token, nonce, 'other-service', '203.0.113.20')).toBe(false);
    expect(verifyChallenge(token, 'wrong', siteId, '203.0.113.20')).toBe(false);
    expect(verifyChallenge(`${token}x`, nonce, siteId, '203.0.113.20')).toBe(false);
  });

  test('a challenge goes stale rather than living for ever', () => {
    const token = issueChallenge(siteId, '203.0.113.22');
    const nonce = solveChallenge(token);
    const inAnHour = Date.now() + 60 * 60 * 1000;
    expect(verifyChallenge(token, nonce, siteId, '203.0.113.22', inAnHour)).toBe(false);
  });

  test('a spoofed address cannot smuggle a later expiry past the parser', () => {
    // The old join used a plain separator; an address of `1.1.1.1|9999999999999`
    // rewrote the expiry to never. Each field is encoded now, so the separator
    // cannot appear inside one and the expiry stays what we set.
    const evilIp = '1.1.1.1.99999999999999';
    const token = issueChallenge(siteId, evilIp);
    const nonce = solveChallenge(token);
    // It verifies for the exact spoofed string...
    expect(verifyChallenge(token, nonce, siteId, evilIp)).toBe(true);
    // ...but a year on it has still expired, i.e. the TTL was not defeated.
    const inAYear = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(verifyChallenge(token, nonce, siteId, evilIp, inAYear)).toBe(false);
  });
});

describe('the challenge endpoints, as the page uses them', () => {
  test('issue, solve, submit: the wall comes down for that address', async () => {
    const ip = '203.0.113.30';
    observeTraffic(burst(ip, CHALLENGE_THRESHOLD.strict + 1), strict);
    expect(wallsFor(siteId).challenged).toContain(ip);

    const issued = await app.request('/api/public/challenge', {
      headers: {
        'x-derailed-service': siteId,
        'x-derailed-proxy': proxySecret(),
        'x-forwarded-for': ip,
      },
    });
    expect(issued.status).toBe(200);
    const { token, prefix } = (await issued.json()) as { token: string; prefix: string };
    expect(prefix.length).toBeGreaterThan(2);

    const answered = await app.request('/api/public/challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-derailed-service': siteId,
        'x-derailed-proxy': proxySecret(),
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ token, nonce: solveChallenge(token) }),
    });
    expect(answered.status).toBe(204);
    expect(wallsFor(siteId).challenged).not.toContain(ip);
  });

  test('a wrong answer changes nothing', async () => {
    const ip = '203.0.113.31';
    observeTraffic(burst(ip, CHALLENGE_THRESHOLD.strict + 1), strict);
    const issued = await app.request('/api/public/challenge', {
      headers: {
        'x-derailed-service': siteId,
        'x-derailed-proxy': proxySecret(),
        'x-forwarded-for': ip,
      },
    });
    const { token } = (await issued.json()) as { token: string };
    const answered = await app.request('/api/public/challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-derailed-service': siteId,
        'x-derailed-proxy': proxySecret(),
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ token, nonce: 'not-the-answer' }),
    });
    expect(answered.status).toBe(400);
    expect(wallsFor(siteId).challenged).toContain(ip);
  });
});

describe('what the proxy is told', () => {
  const base: RouteSpec = {
    hostname: 'blog.example.com',
    upstream: 'd_g_blog_abc',
    port: 80,
    https: true,
  };

  test('banned addresses meet a 429, challenged ones meet the puzzle', () => {
    const text = JSON.stringify(
      synthesizeCaddyConfig(
        [
          {
            ...base,
            bots: {
              serviceId: 'svc',
              blockAi: false,
              challenged: ['203.0.113.40'],
              banned: ['203.0.113.41'],
              panelUpstream: 'host.docker.internal',
              panelPort: 8422,
            },
          },
        ],
        { httpPort: 80, httpsPort: 443 },
      ),
    );
    expect(text).toContain('203.0.113.41');
    expect(text).toContain('429');
    expect(text).toContain('checking that you are visiting with a browser');
    expect(text).toContain('/api/public/challenge');
  });

  test('the AI toggle blocks the named crawlers and serves their robots.txt', () => {
    const text = JSON.stringify(
      synthesizeCaddyConfig(
        [
          {
            ...base,
            bots: {
              serviceId: 'svc',
              blockAi: true,
              challenged: [],
              banned: [],
              panelUpstream: 'host.docker.internal',
              panelPort: 8422,
            },
          },
        ],
        { httpPort: 80, httpsPort: 443 },
      ),
    );
    expect(text).toContain('*GPTBot*');
    expect(text).toContain('*ClaudeBot*');
    expect(text).toContain('robots.txt');
    expect(text).toContain('does not serve automated crawlers');
  });

  test('robots.txt names every crawler on the list and allows everyone else', () => {
    const robots = aiRobotsTxt();
    for (const name of AI_CRAWLERS) expect(robots).toContain(`User-agent: ${name}`);
    expect(robots).toContain('User-agent: *\nAllow: /');
  });

  test('an app with everything off carries no bot machinery at all', () => {
    const text = JSON.stringify(synthesizeCaddyConfig([base], { httpPort: 80, httpsPort: 443 }));
    expect(text).not.toContain('/api/public/challenge');
    expect(text).not.toContain('GPTBot');
  });
});

describe('the settings, and who may touch them', () => {
  function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  test('reads back what is set, and how many addresses are against a wall', async () => {
    observeTraffic(burst('203.0.113.50', CHALLENGE_THRESHOLD.strict + 1), strict);
    const answer = await call('GET', `/api/services/${siteId}/bots`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { mode: string; challenged: number };
    expect(body.mode).toBe('strict');
    expect(body.challenged).toBeGreaterThan(0);
  });

  test('changes both settings in one write', async () => {
    const answer = await call('PUT', `/api/services/${siteId}/bots`, {
      mode: 'polite',
      blockAi: true,
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ mode: 'polite', blockAi: true });
    await call('PUT', `/api/services/${siteId}/bots`, { mode: 'strict', blockAi: false });
  });

  test('a member may, a viewer may only look', () => {
    expect(mayCall('member', 'PUT', '/api/services/x/bots').ok).toBe(true);
    expect(mayCall('viewer', 'GET', '/api/services/x/bots').ok).toBe(true);
    expect(mayCall('viewer', 'PUT', '/api/services/x/bots').ok).toBe(false);
  });
});

describe('bots on the chart', () => {
  test('the crawlers land in the grey, not among the people', () => {
    const now = Date.now();
    recordTraffic([
      {
        serviceId: siteId,
        at: now,
        status: 200,
        bytes: 10,
        ms: 5,
        path: '/',
        referrer: '',
        userAgent: 'Mozilla/5.0 (Macintosh) Chrome/145',
        ip: '203.0.113.60',
      },
      {
        serviceId: siteId,
        at: now,
        status: 200,
        bytes: 10,
        ms: 5,
        path: '/',
        referrer: '',
        userAgent: 'GPTBot/1.2 (+https://openai.com/gptbot)',
        ip: '203.0.113.61',
      },
    ]);
    const report = trafficFor(siteId, '24h');
    expect(report.totals.bots).toBe(1);
    const withBots = report.points.filter((point) => point.bots > 0);
    expect(withBots.length).toBe(1);
    expect(isBot('GPTBot/1.2')).toBe(true);
    expect(isBot('ClaudeBot/1.0')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh) Chrome/145')).toBe(false);
  });
});
