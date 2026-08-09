/**
 * Metamorphic tests for the proxy trust boundary.
 *
 * The rule the whole design rests on: a request is believed to have come through our
 * own proxy only if it carries a secret that lives solely inside the Caddy config, and
 * the app behind the proxy is never handed the headers Derailed uses to vouch for a
 * request. "Metamorphic" here means we vary the one thing that should decide the
 * outcome (was it stamped by the proxy?) and hold everything else, and assert the
 * decision follows only that, never what the client tried to stamp for itself.
 *
 * Two layers. The synthesised Caddy config is checked structurally: every app route,
 * and every dev route, strips the inbound X-Derailed-* headers, whatever features are
 * bolted on. And the real app is driven: a public sink answers only when the proxy
 * secret is present and 404s a client that reaches its port directly, however it
 * dresses the request up.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { proxySecret } from '../src/http/proxytrust.ts';
import { synthesizeCaddyConfig } from '../src/proxy/routes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-metamorphic-'));
let app: ReturnType<typeof createApp>;
let secret = '';
let formsServiceId = '';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  secret = proxySecret();
  // A real app that accepts form submissions, so a correctly-stamped request can get
  // past the trust gate and reach a different answer than the gate's own 404.
  const project = createProject('Site');
  const service = createAppService({
    projectId: project.id,
    name: 'landing',
    source: 'upload',
    image: null,
    repoUrl: null,
    branch: null,
    forms: true,
  });
  formsServiceId = service.id;
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

const TRUST_HEADERS = [
  'X-Derailed-Proxy',
  'X-Derailed-Service',
  'X-Derailed-User',
  'X-Derailed-Form-Host',
];

/** Collect every reverse_proxy in the config, tagged app vs panel by its upstream. */
function reverseProxies(config: unknown): { dial: string; deletes: string[] }[] {
  const out: { dial: string; deletes: string[] }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (obj.handler === 'reverse_proxy') {
        const dial = String((obj.upstreams as { dial?: string }[] | undefined)?.[0]?.dial ?? '');
        const deletes =
          (obj.headers as { request?: { delete?: string[] } } | undefined)?.request?.delete ?? [];
        out.push({ dial, deletes });
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(config);
  return out;
}

describe('the synthesised config strips trust headers whatever is bolted on', () => {
  test('an app route deletes the X-Derailed-* headers across every feature combination', () => {
    fc.assert(
      fc.property(
        fc.record({
          https: fc.boolean(),
          bots: fc.boolean(),
          login: fc.boolean(),
          forms: fc.boolean(),
          images: fc.boolean(),
        }),
        (features) => {
          const panel = { panelUpstream: 'panel', panelPort: 8422 };
          const route = {
            hostname: 'app.example.com',
            upstream: 'd_app_container',
            port: 80,
            https: features.https,
            panelSecret: 'sekret',
            bots: features.bots
              ? { serviceId: 's', blockAi: true, challenged: [], banned: [], ...panel }
              : undefined,
            login: features.login ? { serviceId: 's', ...panel } : undefined,
            forms: features.forms ? { serviceId: 's', ...panel } : undefined,
            images: features.images,
          };
          const config = synthesizeCaddyConfig([route] as never, { httpPort: 80, httpsPort: 443 });
          // The proxy that dials the app container must strip all four trust headers.
          const appProxy = reverseProxies(config).find((p) => p.dial.includes('d_app_container'));
          if (!appProxy) return false;
          return TRUST_HEADERS.every((h) => appProxy.deletes.includes(h));
        },
      ),
      { numRuns: 500 },
    );
  });

  test('a dev route strips the caller X-Derailed-* before forwarding to the panel', () => {
    // The v0.11.0 dev-tunnel forgery: the dev branch stamped a valid proxy secret but
    // had no delete block, so a visitor's X-Derailed-Service rode through to the panel
    // sinks cross-tenant. The delete block must be present.
    const route = {
      hostname: 'wip.example.com',
      upstream: 'ignored',
      port: 80,
      https: true,
      panelSecret: 'sekret',
      dev: { sub: 'sunny-fox', panelUpstream: 'panel', panelPort: 8422 },
    };
    const config = synthesizeCaddyConfig([route] as never, { httpPort: 80, httpsPort: 443 });
    const devProxy = reverseProxies(config).find((p) => p.dial.includes('panel'));
    expect(devProxy).toBeDefined();
    for (const h of ['X-Derailed-Proxy', 'X-Derailed-Service', 'X-Derailed-User']) {
      expect(devProxy?.deletes).toContain(h);
    }
  });
});

describe('a public sink believes only the proxy secret, never the client', () => {
  // The form sink 404s anything that did not come through the proxy. Vary only the
  // proxy stamp; hold the rest. Without the secret, no header the client invents opens
  // the door; with the wrong secret, likewise.
  async function postForm(headers: Record<string, string>, body = 'name=x'): Promise<Response> {
    return app.request('/api/public/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    });
  }

  test('no proxy stamp, or a forged one, is refused however the client dresses it up', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.record({
          user: fc.string({ maxLength: 12 }),
          forgedSecret: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
        }),
        async (attempt) => {
          // Even naming the real, forms-enabled service, a request that cannot prove it
          // came through the proxy is refused: the service header is only an
          // authorization decision once the stamp checks out.
          const headers: Record<string, string> = {
            'X-Derailed-Service': formsServiceId,
            'X-Derailed-User': attempt.user,
          };
          if (attempt.forgedSecret !== undefined && attempt.forgedSecret !== secret) {
            headers['X-Derailed-Proxy'] = attempt.forgedSecret;
          }
          const res = await postForm(headers);
          // The sink hides itself entirely from a direct caller.
          return res.status === 404;
        },
      ),
      { numRuns: 500 },
    );
  });

  test('the very same request, with the real proxy secret, is no longer the gate 404', async () => {
    // The metamorphic pair: byte-for-byte the same request but for the proxy stamp,
    // aimed at the real forms-enabled service. Without the stamp it is the gate's flat
    // 404; with it, the request is admitted and answered on its merits (a submission
    // is accepted), proving the gate keys on the secret and nothing the client sent.
    const common = {
      'X-Derailed-Service': formsServiceId,
      'X-Derailed-Form-Host': 'landing.example.com',
    };
    const withoutStamp = await postForm(common);
    const withStamp = await postForm({ ...common, 'X-Derailed-Proxy': secret });

    expect(withoutStamp.status).toBe(404);
    expect(withStamp.status).not.toBe(404);
  });
});
