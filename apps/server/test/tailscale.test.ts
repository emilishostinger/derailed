import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createDomain } from '../src/db/repo/domains.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { currentRoutes } from '../src/proxy/sync.ts';
import { isTailnetHostname, parseStatus, tailscaleState } from '../src/system/tailscale.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The cupboard computer. What can be proven without a tailnet in the building:
 * the status parsing, the honesty of the not-installed answer, the routing a
 * ts.net name gets, and who is allowed to press any of these buttons.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-tailscale-'));
let app: ReturnType<typeof createApp>;
let cookie = '';

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
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('reading what tailscale says', () => {
  test('a running tailnet: name without the trailing dot, the v4 address, the tailnet', () => {
    const parsed = parseStatus(
      JSON.stringify({
        BackendState: 'Running',
        Self: {
          DNSName: 'cupboard.tail1234.ts.net.',
          TailscaleIPs: ['100.101.102.103', 'fd7a:115c::1'],
        },
        CurrentTailnet: { Name: 'someone@example.com' },
      }),
    );
    expect(parsed.connected).toBe(true);
    expect(parsed.dnsName).toBe('cupboard.tail1234.ts.net');
    expect(parsed.ip).toBe('100.101.102.103');
    expect(parsed.tailnet).toBe('someone@example.com');
  });

  test('logged out means nothing is claimed, whatever fields linger', () => {
    const parsed = parseStatus(
      JSON.stringify({
        BackendState: 'NeedsLogin',
        Self: { DNSName: 'stale.ts.net.', TailscaleIPs: ['100.1.2.3'] },
      }),
    );
    expect(parsed.connected).toBe(false);
    expect(parsed.dnsName).toBeNull();
    expect(parsed.ip).toBeNull();
  });

  test('garbage is not a tailnet', () => {
    expect(parseStatus('not json').connected).toBe(false);
  });
});

describe('the honest not-installed answer', () => {
  test('a machine without the binary says so instead of guessing', async () => {
    // This test machine may or may not have tailscale; either way the answer
    // has to be internally consistent.
    const state = await tailscaleState();
    if (!state.installed) {
      expect(state.connected).toBe(false);
      expect(state.dnsName).toBeNull();
      expect(state.funnelOn).toBe(false);
    }
  });
});

describe('how a ts.net name is routed', () => {
  test('no DNS check to wait for, and no certificate for Caddy to chase', async () => {
    const project = createProject('Cupboard');
    const service = createAppService({
      projectId: project.id,
      name: 'blog',
      source: 'image',
      image: 'x:1',
      repoUrl: null,
      branch: null,
      port: 80,
    });
    // A running deployment is what routes a domain at all.
    const { createDeployment, updateDeployment } = await import('../src/db/repo/deployments.ts');
    const deployment = createDeployment(service.id, 'manual');
    updateDeployment(deployment.id, { status: 'running' });

    createDomain(service.id, 'cupboard.tail1234.ts.net', 'custom', 'ok', 'disabled');

    const routes = currentRoutes();
    const route = routes.find((entry) => entry.hostname === 'cupboard.tail1234.ts.net');
    expect(route).toBeDefined();
    // Plain HTTP inside: tailscaled holds the certificate and terminates TLS.
    expect(route!.https).toBe(false);

    expect(isTailnetHostname('cupboard.tail1234.ts.net')).toBe(true);
    expect(isTailnetHostname('shop.example.com')).toBe(false);
  });
});

describe('who may press these buttons', () => {
  test('joining networks and opening funnels is an owner’s', () => {
    expect(mayCall('member', 'POST', '/api/system/tailscale/connect').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/system/tailscale/install').ok).toBe(false);
    expect(mayCall('member', 'PUT', '/api/system/tailscale/funnel').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/system/tailscale').ok).toBe(true);
    expect(mayCall('owner', 'PUT', '/api/system/tailscale/funnel').ok).toBe(true);
  });

  test('the routes are mounted and answer in character', async () => {
    const state = await app.request('/api/system/tailscale', {
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(state.status).toBe(200);
    const body = (await state.json()) as { installed: boolean };
    expect(typeof body.installed).toBe('boolean');

    // The funnel refuses plainly rather than pretending: no tailnet on this
    // machine means "connect first", and a connected machine still refuses the
    // made-up app. Either way, a refusal with a sentence, never a 500.
    const funnel = await app.request('/api/system/tailscale/funnel', {
      method: 'PUT',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ serviceId: 'made-up-app' }),
    });
    expect([400, 404]).toContain(funnel.status);
    const refusal = (await funnel.json()) as { error: { message: string } };
    expect(refusal.error.message.length).toBeGreaterThan(5);
  });
});
