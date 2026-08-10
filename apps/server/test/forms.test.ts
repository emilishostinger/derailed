import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectFormPlumbing } from '../src/build/site.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { countSubmissions, listSubmissions } from '../src/db/repo/forms.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { proxySecret } from '../src/http/proxytrust.ts';
import { safeRedirect } from '../src/http/routes/forms.ts';
import { type RouteSpec, synthesizeCaddyConfig } from '../src/proxy/routes.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Forms: the folder-of-HTML crowd gets a working contact form with no backend,
 * no service and no account. The proxy catches the POST a static site could
 * never answer; everything here proves what happens on either side of that.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-forms-'));
let app: ReturnType<typeof createApp>;
let cookie = '';
let siteId = '';
let projectId = '';

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

  const project = createProject('Site');
  projectId = project.id;
  const site = createAppService({
    projectId,
    name: 'brochure',
    source: 'upload',
    repoUrl: null,
    branch: null,
  });
  siteId = site.id;
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** What the proxy sends: an ordinary browser POST plus the service's identity. */
function submit(body: Record<string, string>, overrides: Record<string, string> = {}) {
  return app.request('/api/public/form', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-derailed-service': siteId,
      'x-derailed-proxy': proxySecret(),
      'x-forwarded-for': '198.51.100.7',
      ...overrides,
    },
    body: new URLSearchParams(body).toString(),
  });
}

describe('the markup means what it looks like it means', () => {
  test('a data-derailed form gains a method and carries its name', () => {
    const { html, forms } = injectFormPlumbing(
      '<html><body><form data-derailed="contact"><input name="email"></form></body></html>',
    );
    expect(forms).toBe(1);
    expect(html).toContain('method="post"');
    expect(html).toContain('<input type="hidden" name="_derailed" value="contact">');
  });

  test('a method the author wrote is left alone', () => {
    const { html } = injectFormPlumbing('<form method="POST" data-derailed="rsvp"></form>');
    expect(html.match(/method/gi)?.length).toBe(1);
    expect(html).toContain('value="rsvp"');
  });

  test('forms without the attribute are not touched', () => {
    const original = '<form action="/search" method="get"></form>';
    const { html, forms } = injectFormPlumbing(original);
    expect(forms).toBe(0);
    expect(html).toBe(original);
  });
});

describe('what the catcher accepts', () => {
  test('an ordinary browser POST, no special headers, becomes a message', async () => {
    const answer = await submit({
      _derailed: 'contact',
      email: 'someone@example.com',
      message: 'hello there',
    });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('Message sent');

    const [message] = listSubmissions(siteId);
    expect(message!.form).toBe('contact');
    expect(message!.fields.email).toBe('someone@example.com');
    expect(message!.ip).toBe('198.51.100.7');
  });

  test('the honeypot eats bots and thanks them anyway', async () => {
    const before = countSubmissions(siteId);
    const answer = await submit({ _gotcha: 'https://spam.example', email: 'bot@bot' });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('Message sent');
    expect(countSubmissions(siteId)).toBe(before);
  });

  test('a JSON POST is refused: this is a form catcher, not an API', async () => {
    const answer = await submit({}, { 'content-type': 'application/json' });
    expect(answer.status).toBe(415);
  });

  test('an app that has not asked for forms does not have them', async () => {
    const other = createAppService({
      projectId,
      name: 'api',
      repoUrl: 'https://github.com/example/api',
      branch: 'main',
    });
    expect(findService(other.id)?.forms).toBe(false);
    const answer = await submit({ email: 'x' }, { 'x-derailed-service': other.id });
    expect(answer.status).toBe(404);
  });

  test('a request straight to the panel port, forging the service, is refused', async () => {
    // No proxy secret: this is what a request to the open panel port looks like,
    // with every header attacker-chosen. It must not be able to write to an
    // app's inbox or mail its owners.
    const before = countSubmissions(siteId);
    const forged = await app.request('/api/public/form', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-derailed-service': siteId,
        'x-forwarded-for': '6.6.6.6',
      },
      body: new URLSearchParams({ email: 'spam@evil.example' }).toString(),
    });
    expect(forged.status).toBe(404);
    expect(countSubmissions(siteId)).toBe(before);
  });

  test('a redirect can only point into the same site, backslashes included', async () => {
    const good = await submit({ email: 'x@y.z', _redirect: '/thanks.html' });
    expect(good.status).toBe(303);
    expect(good.headers.get('location')).toBe('/thanks.html');

    const bad = await submit({ email: 'x@y.z', _redirect: 'https://evil.example/' });
    expect(bad.status).toBe(200);

    // The backslash bypass: `/\evil.example` is off-site to a browser.
    const slash = await submit({ email: 'x@y.z', _redirect: '/\\evil.example' });
    expect(slash.status).toBe(200);

    expect(safeRedirect('/fine')).toBe('/fine');
    expect(safeRedirect('//not-a-path.example')).toBeNull();
    expect(safeRedirect('/\\evil.example')).toBeNull();
    expect(safeRedirect('/ok/\\..//evil')).toBeNull();
    expect(safeRedirect('https://elsewhere.example')).toBeNull();
    expect(safeRedirect('')).toBeNull();
  });

  test('a honeypot after sixty decoy fields is still seen', async () => {
    const padded: Record<string, string> = {};
    for (let i = 0; i < 65; i++) padded[`field${i}`] = 'x';
    padded._gotcha = 'i-am-a-bot';
    const before = countSubmissions(siteId);
    const answer = await submit(padded);
    expect(answer.status).toBe(200);
    // Fed the honeypot behind padding: still caught, still nothing stored.
    expect(countSubmissions(siteId)).toBe(before);
  });

  test('a flood from one address is slowed down', async () => {
    let refused = 0;
    for (let i = 0; i < 15; i++) {
      const answer = await submit(
        { email: `flood${i}@example.com` },
        { 'x-forwarded-for': '203.0.113.99' },
      );
      if (answer.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('the messages tab', () => {
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

  test('lists what arrived, newest first', async () => {
    const answer = await call('GET', `/api/services/${siteId}/messages`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { enabled: boolean; total: number };
    expect(body.enabled).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  test('exports a spreadsheet that cannot run formulas', async () => {
    await submit({ email: 'safe@example.com', note: '=HYPERLINK("https://evil")' });
    const answer = await call('GET', `/api/services/${siteId}/messages/export`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/csv');
    const csv = await answer.text();
    expect(csv).toContain('safe@example.com');
    // The formula arrives defused, not deleted.
    expect(csv).toContain(`'=HYPERLINK`);
  });

  test('the toggle turns catching off, and the catcher agrees', async () => {
    const off = await call('PUT', `/api/services/${siteId}/messages/settings`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    const refused = await submit({ email: 'late@example.com' });
    expect(refused.status).toBe(404);
    await call('PUT', `/api/services/${siteId}/messages/settings`, { enabled: true });
  });

  test('deleting a message deletes that message', async () => {
    const [message] = listSubmissions(siteId);
    const answer = await call('DELETE', `/api/services/${siteId}/messages/${message!.id}`);
    expect(answer.status).toBe(200);
    expect(listSubmissions(siteId).some((entry) => entry.id === message!.id)).toBe(false);
  });

  test('a viewer may read but not change', () => {
    expect(mayCall('viewer', 'GET', '/api/services/x/messages').ok).toBe(true);
    expect(mayCall('viewer', 'PUT', '/api/services/x/messages/settings').ok).toBe(false);
    expect(mayCall('viewer', 'DELETE', '/api/services/x/messages/y').ok).toBe(false);
    expect(mayCall('member', 'PUT', '/api/services/x/messages/settings').ok).toBe(true);
  });
});

describe('what the proxy is told', () => {
  test('a forms app gets a POST catcher behind its access handlers', () => {
    const route: RouteSpec = {
      hostname: 'brochure.example.com',
      upstream: 'd_site_brochure_abc',
      port: 80,
      https: true,
      access: { basicAuth: { username: 'visitor', hash: '$2a$x' } },
      forms: { serviceId: 'svc1', panelUpstream: 'host.docker.internal', panelPort: 1337 },
    };
    const config = synthesizeCaddyConfig([route], { httpPort: 80, httpsPort: 443 });
    const text = JSON.stringify(config);

    expect(text).toContain('"method":["POST"]');
    expect(text).toContain('/api/public/form');
    expect(text).toContain('X-Derailed-Service');
    // The password comes before the catcher: a private site's forms are private.
    expect(text.indexOf('http_basic')).toBeLessThan(text.indexOf('/api/public/form'));
  });

  test('an app without forms has no catcher in its route', () => {
    const route: RouteSpec = {
      hostname: 'app.example.com',
      upstream: 'd_p_app_abc',
      port: 3000,
      https: true,
    };
    const text = JSON.stringify(synthesizeCaddyConfig([route], { httpPort: 80, httpsPort: 443 }));
    expect(text).not.toContain('/api/public/form');
  });
});
