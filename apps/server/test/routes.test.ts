/**
 * Every endpoint the dashboard calls has to be *mounted*, not merely written. A whole
 * feature's routes once existed as a typechecking, tested file that was never wired
 * into the Hono app, so the UI got a 404 from code that looked finished. These tests
 * assert reachability only: anything but "that endpoint doesn't exist" is a pass.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-routes-'));
let app: ReturnType<typeof createApp>;
let cookie: string;

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

function call(method: string, path: string) {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      cookie,
    },
    body: method === 'GET' ? undefined : '{}',
  });
}

/** The 404 the router emits for an unknown path, as opposed to a missing record. */
async function isUnroutedPath(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return (body?.error?.message ?? '').includes('endpoint');
}

const ROUTES: [string, string][] = [
  // Phase 3, domains
  ['GET', '/api/services/nope/domains'],
  ['POST', '/api/services/nope/domains'],
  ['DELETE', '/api/domains/nope'],
  ['POST', '/api/domains/nope/check'],
  // Phase 4, databases and links
  ['GET', '/api/catalog/databases'],
  ['GET', '/api/services/nope/connection'],
  ['POST', '/api/services/nope/expose'],
  ['POST', '/api/services/nope/links'],
  ['DELETE', '/api/links/nope'],
  // Rollback
  ['POST', '/api/deployments/nope/rollback'],
  // Backup-first updates
  ['GET', '/api/services/nope/update'],
  ['POST', '/api/services/nope/update'],
  ['POST', '/api/services/nope/update/revert'],
  ['PUT', '/api/services/nope/auto-update'],
  // Databases growing up, and winding back
  ['GET', '/api/services/nope/upgrade'],
  ['POST', '/api/services/nope/upgrade'],
  ['GET', '/api/services/nope/pitr'],
  ['PUT', '/api/services/nope/pitr'],
  ['POST', '/api/services/nope/pitr/restore'],
  // Compose import
  ['POST', '/api/import/inspect'],
  ['POST', '/api/projects/nope/import'],
  // Bots
  ['GET', '/api/services/nope/bots'],
  ['PUT', '/api/services/nope/bots'],
  // Is anything leaking or known-broken?
  ['GET', '/api/system/scan'],
  ['POST', '/api/system/scan'],
  // What will change
  ['GET', '/api/projects/nope/pending'],
  ['POST', '/api/projects/nope/pending/apply'],
  ['DELETE', '/api/projects/nope/pending'],
  ['PUT', '/api/projects/nope/review'],
  ['GET', '/api/projects/nope/env/history'],
  ['GET', '/api/services/nope/env/history'],
  // SSH keys, and the toggle that matters
  ['GET', '/api/system/ssh'],
  ['POST', '/api/system/ssh/keys'],
  ['DELETE', '/api/system/ssh/keys'],
  ['PUT', '/api/system/ssh/password-login'],
  // The cupboard computer
  ['GET', '/api/system/tailscale'],
  ['POST', '/api/system/tailscale/connect'],
  ['PUT', '/api/system/tailscale/funnel'],
  // One login in front of any app
  ['GET', '/api/services/nope/login'],
  ['PUT', '/api/services/nope/login'],
  ['DELETE', '/api/services/nope/login/sessions/some'],
  // Forms
  ['GET', '/api/services/nope/messages'],
  ['PUT', '/api/services/nope/messages/settings'],
  ['DELETE', '/api/services/nope/messages/some'],
  ['GET', '/api/services/nope/messages/export'],
];

describe('every route the dashboard calls is mounted', () => {
  for (const [method, path] of ROUTES) {
    test(`${method} ${path}`, async () => {
      const response = await call(method, path);
      expect(await isUnroutedPath(response)).toBe(false);
    });
  }

  test('a genuinely unknown path still 404s', async () => {
    const response = await call('GET', '/api/not-a-real-endpoint');
    expect(await isUnroutedPath(response)).toBe(true);
  });

  test('the catalog lists the engines the wizard offers', async () => {
    const response = await call('GET', '/api/catalog/databases');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { engines: { engine: string }[] };
    const engines = body.engines.map((entry) => entry.engine);
    expect(engines).toContain('postgres');
    expect(engines).toContain('mysql');
    expect(engines).toContain('redis');
  });
});

describe('errors reach the user in plain language', () => {
  test('a FriendlyError is not flattened into a generic 500', async () => {
    // The catalog, the git layer and the build pipeline all throw FriendlyError, and
    // it already carries the message and hint a person needs. It used to fall through
    // to "Something went wrong on the server", which threw all of that away.
    const setup = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ name: 'Errors' }),
    });
    const { project } = (await setup.json()) as { project: { id: string } };

    const response = await app.request(`/api/projects/${project.id}/services`, {
      method: 'POST',
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ kind: 'database', name: 'db', engine: 'mysql', version: '8' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; hint?: string } };
    expect(body.error.message).toContain('MySQL 8');
    expect(body.error.hint).toContain('8.0');
  });
});

describe('storage that survives a redeploy', () => {
  async function call(method: string, path: string, body?: unknown) {
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

  let serviceId = '';

  test('an app can be given a folder to keep', async () => {
    const projectRes = await call('POST', '/api/projects', { name: 'Storage' });
    const { project } = (await projectRes.json()) as { project: { id: string } };

    const serviceRes = await call('POST', `/api/projects/${project.id}/services`, {
      kind: 'app',
      name: 'app',
      repoUrl: 'https://github.com/example/app',
      deployNow: false,
    });
    const { service } = (await serviceRes.json()) as { service: { id: string } };
    serviceId = service.id;

    const created = await call('POST', `/api/services/${serviceId}/volumes`, {
      containerPath: '/var/www/html/wp-content',
    });
    expect(created.status).toBe(201);

    const list = await call('GET', `/api/services/${serviceId}/volumes`);
    const { volumes } = (await list.json()) as { volumes: { containerPath: string }[] };
    expect(volumes.map((v) => v.containerPath)).toEqual(['/var/www/html/wp-content']);
  });

  test('the same folder cannot be kept twice', async () => {
    const again = await call('POST', `/api/services/${serviceId}/volumes`, {
      containerPath: '/var/www/html/wp-content',
    });
    expect(again.status).toBe(409);
  });

  test('refuses to mount over the system folders inside the app', async () => {
    // Mounting an empty volume over /etc or /usr leaves a container that cannot start,
    // with an error that says nothing useful about why.
    for (const path of ['/etc', '/usr', '/bin']) {
      const response = await call('POST', `/api/services/${serviceId}/volumes`, {
        containerPath: path,
      });
      expect(response.status).toBe(400);
    }
  });

  test('rejects a path that is not a path', async () => {
    const response = await call('POST', `/api/services/${serviceId}/volumes`, {
      containerPath: 'wp-content',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('starting with a slash');
  });
});

describe('the ready-made app catalog', () => {
  test('lists apps with plain-language descriptions', async () => {
    const response = await app.request('/api/templates', {
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      templates: { slug: string; name: string; blurb: string; needsDatabase: boolean }[];
    };
    const slugs = body.templates.map((t) => t.slug);
    expect(slugs).toContain('wordpress');
    expect(slugs).toContain('ghost');

    const wordpress = body.templates.find((t) => t.slug === 'wordpress')!;
    expect(wordpress.needsDatabase).toBe(true);
    // Every template has to read as a sentence, not a package name.
    for (const template of body.templates) {
      expect(template.blurb.length).toBeGreaterThan(20);
      expect(template.name).not.toContain(':');
    }
  });

  test('refuses an app it does not have', async () => {
    const projectRes = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Templates' }),
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };

    const response = await app.request(`/api/projects/${project.id}/templates`, {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ slug: 'not-a-real-app' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('every template is internally consistent', () => {
  test('each one that needs a database maps real connection details', async () => {
    // A template whose env mapping is wrong produces an app that deploys and then
    // fails to connect, which is the worst possible failure for a one-click install.
    const { APP_TEMPLATES } = await import('../src/catalog/templates.ts');
    const { findEngine } = await import('../src/catalog/databases.ts');

    for (const template of APP_TEMPLATES) {
      expect(template.image).toMatch(/:/);
      expect(template.port).toBeGreaterThan(0);
      expect(template.afterDeploy.length).toBeGreaterThan(10);

      if (!template.database) continue;
      const engine = findEngine(template.database.engine);
      expect(engine).toBeDefined();
      expect(engine!.versions).toContain(template.database.version);

      const mapped = template.database.env({
        host: 'db-host',
        port: engine!.port,
        dbName: 'app',
        user: 'derailed',
        password: 'secret',
        url: 'postgres://derailed:secret@db-host:5432/app',
      });
      expect(Object.keys(mapped).length).toBeGreaterThan(0);
      // The password has to actually reach the app somehow.
      expect(JSON.stringify(mapped)).toContain('secret');
    }
  });
});

describe('private repository tokens', () => {
  let serviceId = '';

  test('a token can be saved but never read back', async () => {
    const projectRes = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Private' }),
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };

    const serviceRes = await app.request(`/api/projects/${project.id}/services`, {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        kind: 'app',
        name: 'secret',
        repoUrl: 'https://github.com/example/private',
        deployNow: false,
      }),
    });
    const { service } = (await serviceRes.json()) as { service: { id: string } };
    serviceId = service.id;

    const saved = await app.request(`/api/services/${serviceId}/repo-token`, {
      method: 'PUT',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: 'github_pat_11ABCDEFG0123456789abcdefg' }),
    });
    expect(saved.status).toBe(200);

    // The service is returned, but the token must not be anywhere in the payload.
    const body = await saved.text();
    expect(body).not.toContain('github_pat_');
    expect(body).toContain('"hasRepoToken":true');

    const fetched = await app.request(`/api/services/${serviceId}`, {
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(await fetched.text()).not.toContain('github_pat_');
  });

  test('rejects something that is obviously not a token', async () => {
    const response = await app.request(`/api/services/${serviceId}/repo-token`, {
      method: 'PUT',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: 'hunter2' }),
    });
    expect(response.status).toBe(400);
  });

  test('it can be removed again', async () => {
    const response = await app.request(`/api/services/${serviceId}/repo-token`, {
      method: 'PUT',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ token: null }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"hasRepoToken":false');
  });
});

describe('API tokens for coding agents', () => {
  let secret = '';
  let tokenId = '';

  test('a token is returned once and then only ever as a hash', async () => {
    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Claude Code' }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { secret: string; token: { id: string } };
    expect(body.secret).toStartWith('drl_');
    secret = body.secret;
    tokenId = body.token.id;

    // Listing them must never include the secret again.
    const list = await app.request('/api/tokens', {
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(await list.text()).not.toContain(secret);
  });

  test('the token authenticates without a session or a CSRF header', async () => {
    // This is the whole point: an agent has neither a cookie jar nor a browser.
    const response = await app.request('/api/projects', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);

    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'From an agent' }),
    });
    expect(created.status).toBe(201);
  });

  test('a wrong token is refused', async () => {
    const response = await app.request('/api/projects', {
      headers: { authorization: 'Bearer drl_not-a-real-token' },
    });
    expect(response.status).toBe(401);
  });

  test('revoking one stops it working immediately', async () => {
    const revoked = await app.request(`/api/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(revoked.status).toBe(200);

    const response = await app.request('/api/projects', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('the MCP tool surface', () => {
  test('every tool is described in a way a model can act on', async () => {
    const { TOOLS } = await import('../src/mcp/tools.ts');
    expect(TOOLS.length).toBeGreaterThan(8);

    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // A one-word description leaves the model guessing when to reach for it.
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe('object');
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(required);
      }
    }

    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
