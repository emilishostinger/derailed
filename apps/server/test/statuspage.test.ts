/**
 * The status page, which is the one page here that strangers read.
 *
 * Two things matter and neither is how it looks. It must not say anything about the
 * machine it runs on, and it must not claim things are fine when nobody has checked.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createDomain, isOnStatusPage, setOnStatusPage } from '../src/db/repo/domains.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { SETTINGS, setBoolSetting, setSetting } from '../src/db/repo/settings.ts';
import { createApp } from '../src/http/app.ts';
import { renderStatusPage } from '../src/http/statuspage.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-statuspage-'));
let app: ReturnType<typeof createApp>;
let service = '';

const PROJECT = 'Confidential Client Work';
const SERVICE = 'internal-billing-api';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const project = createProject(PROJECT);
  const created = createAppService({
    projectId: project.id,
    name: SERVICE,
    repoUrl: null,
    branch: null,
  });
  service = created.id;
  createDomain(service, 'shop.example.com', 'custom', 'ok', 'active', null);
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

function page(sites: (boolean | null)[]) {
  return renderStatusPage({
    title: 'Status',
    at: Date.now(),
    allUp: !sites.includes(false),
    sites: sites.map((up, index) => ({
      name: `s${index}.example.com`,
      up,
      uptimePercent: up === null ? null : 99.9,
      days: [],
    })),
  });
}

function headline(html: string): string {
  return html.match(/<strong>([^<]*)<\/strong>/)?.[1] ?? '';
}

describe('what it says', () => {
  test('never claims things are fine before anything has been checked', () => {
    // The one sentence that must never appear on a page whose whole job is to be
    // believed. `allUp` counts "never checked" as fine, which is why the page does
    // not use it.
    expect(headline(page([null, null]))).toBe('Not checked yet');
    expect(headline(page([null, null]))).not.toContain('normal');
  });

  test('says so plainly when something is down, and how much', () => {
    expect(headline(page([true, false]))).toBe('One site is down');
    expect(headline(page([false, false]))).toBe('2 sites are down');
  });

  test('does not round a partly-unknown answer up to all clear', () => {
    expect(headline(page([true, null]))).toBe('Everything checked is up');
  });

  test('is confident only when it has earned it', () => {
    expect(headline(page([true, true]))).toBe('All systems normal');
  });

  test('handles having nothing to watch', () => {
    expect(headline(page([]))).toBe('Nothing is being watched yet');
  });
});

describe('what it gives away', () => {
  test('nothing about projects, apps, or this machine', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, true);
    const html = await (await app.request('/status')).text();

    expect(html).toContain('shop.example.com');
    // The domain is public by definition. Everything behind it is not.
    expect(html).not.toContain(PROJECT);
    expect(html).not.toContain(SERVICE);
    expect(html).not.toContain('derailed.db');
    expect(html).not.toMatch(/\b\d+\.\d+\.\d+\b/); // no version
  });

  test('escapes the one value that comes from outside', () => {
    const html = renderStatusPage({
      title: '<script>alert(1)</script>',
      at: Date.now(),
      allUp: true,
      sites: [
        {
          name: '"><script>alert(2)</script>',
          up: true,
          uptimePercent: 100,
          days: [],
        },
      ],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('which addresses appear', () => {
  test('bought ones by default, automatic ones not', () => {
    // An automatic address has the server's IP written into it, so publishing one
    // tells anyone reading the page where the machine lives.
    const bought = createDomain(service, 'bought.example.com', 'custom', 'ok', 'active', null);
    const automatic = createDomain(
      service,
      'app.203-0-113-7.sslip.io',
      'generated',
      'ok',
      'active',
      null,
    );

    expect(isOnStatusPage(bought)).toBe(true);
    expect(isOnStatusPage(automatic)).toBe(false);
  });

  test('but either can be overridden, which is the point', () => {
    // Switching the page on and finding it empty, with nothing saying why, was the
    // whole of this feature's reputation. Somebody on automatic addresses can now
    // publish them knowing what it costs.
    const automatic = createDomain(
      service,
      'other.203-0-113-7.sslip.io',
      'generated',
      'ok',
      'active',
      null,
    );
    expect(isOnStatusPage(setOnStatusPage(automatic.id, true)!)).toBe(true);

    const bought = createDomain(service, 'private.example.com', 'custom', 'ok', 'active', null);
    expect(isOnStatusPage(setOnStatusPage(bought.id, false)!)).toBe(false);

    // And back to deciding by kind.
    expect(isOnStatusPage(setOnStatusPage(bought.id, null)!)).toBe(true);
  });

  test('an opted-in automatic address really does reach the page', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, true);
    const automatic = createDomain(
      service,
      'shown.203-0-113-7.sslip.io',
      'generated',
      'ok',
      'active',
      null,
    );

    expect(await (await app.request('/status')).text()).not.toContain('shown.203-0-113-7');
    setOnStatusPage(automatic.id, true);
    expect(await (await app.request('/status')).text()).toContain('shown.203-0-113-7');
  });
});

describe('how it is served', () => {
  test('is a page, not JSON', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, true);
    const response = await app.request('/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  test('needs no javascript and no request to anywhere', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, true);
    const html = await (await app.request('/status')).text();
    // This is the page people open when everything else is broken. It must not
    // depend on the dashboard's assets, a CDN, or scripting being available.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
    expect(html.match(/https?:\/\//g) ?? []).toEqual([]);
  });

  test('is not there at all until somebody switches it on', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, false);
    const html = await (await app.request('/status')).text();
    expect(html).not.toContain('All systems normal');
    expect(html).not.toContain('shop.example.com');

    const json = await app.request('/api/public/status.json');
    expect(json.status).toBe(404);
  });

  test('the title survives being changed', async () => {
    setBoolSetting(SETTINGS.statusPageEnabled, true);
    setSetting(SETTINGS.statusPageTitle, 'Acme Status');
    const html = await (await app.request('/status')).text();
    expect(html).toContain('<title>Acme Status</title>');
    expect(html).toContain('<h1>Acme Status</h1>');
  });
});
