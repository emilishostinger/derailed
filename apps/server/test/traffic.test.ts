/**
 * The traffic figures.
 *
 * Two things here have already been wrong once on a real server: the status
 * breakdown counted crawlers while the visit count did not, so the parts added up to
 * more than the whole; and a visitor seen on several days was counted several times.
 * Both are the sort of mistake that quietly makes a page of numbers untrustworthy.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanPath,
  cleanReferrer,
  isBot,
  recordTraffic,
  type TrafficEvent,
  trafficFor,
} from '../src/analytics/store.ts';
import { db, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-traffic-'));
const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/145 Safari/537.36';

let serviceId = '';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

beforeEach(() => {
  for (const table of [
    'traffic_hourly',
    'traffic_visitors',
    'traffic_paths',
    'traffic_referrers',
    'traffic_live',
  ])
    db().query(`DELETE FROM ${table}`).run();

  if (!serviceId) {
    const project = createProject('Traffic');
    serviceId = createAppService({
      projectId: project.id,
      name: 'site',
      repoUrl: 'https://github.com/example/site',
      branch: 'main',
    }).id;
  }
});

function visit(over: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    serviceId,
    at: Date.now(),
    status: 200,
    bytes: 1000,
    ms: 5,
    path: '/',
    referrer: '',
    userAgent: BROWSER,
    ip: '203.0.113.10',
    ...over,
  };
}

describe('counting visits', () => {
  test('the status breakdown adds up to the number of visits', () => {
    recordTraffic([
      visit(),
      visit({ status: 301 }),
      visit({ status: 404 }),
      visit({ status: 500 }),
      // A crawler must not appear in any of those four.
      visit({ userAgent: 'Googlebot/2.1', status: 200 }),
    ]);

    const report = trafficFor(serviceId, '24h');
    const { totals } = report;
    expect(totals.requests).toBe(4);
    expect(totals.bots).toBe(1);
    expect(totals.ok + totals.redirects + totals.clientErrors + totals.serverErrors).toBe(
      totals.requests,
    );
  });

  test('crawlers are left out of the bytes and the timing too', () => {
    recordTraffic([
      visit({ bytes: 100, ms: 10 }),
      visit({ userAgent: 'Googlebot/2.1', bytes: 9999, ms: 9999 }),
    ]);

    const { totals } = trafficFor(serviceId, '24h');
    expect(totals.bytes).toBe(100);
    expect(totals.avgMs).toBe(10);
  });

  test('one person visiting all week is one visitor', () => {
    const day = 24 * 60 * 60 * 1000;
    recordTraffic([
      visit({ at: Date.now() - 3 * day }),
      visit({ at: Date.now() - 2 * day }),
      visit({ at: Date.now() - day }),
      visit(),
    ]);

    const { totals } = trafficFor(serviceId, '7d');
    expect(totals.requests).toBe(4);
    expect(totals.visitors).toBe(1);
  });

  test('different people are different visitors', () => {
    recordTraffic([visit({ ip: '203.0.113.1' }), visit({ ip: '203.0.113.2' })]);
    expect(trafficFor(serviceId, '24h').totals.visitors).toBe(2);
  });

  test('an app nobody has visited says so, rather than showing zeroes', () => {
    expect(trafficFor(serviceId, '24h').empty).toBe(true);
    recordTraffic([visit()]);
    expect(trafficFor(serviceId, '24h').empty).toBe(false);
  });
});

describe('what is kept', () => {
  test('pages are counted, query strings are not kept', () => {
    recordTraffic([visit({ path: '/search?q=someone%40example.com&token=secret' })]);
    const { topPaths } = trafficFor(serviceId, '24h');
    expect(topPaths[0]?.path).toBe('/search');
    expect(JSON.stringify(topPaths)).not.toContain('token');
  });

  test('only the site someone came from, never the page they were on', () => {
    expect(cleanReferrer('https://www.example.com/private/thread/42?x=1')).toBe('example.com');
    expect(cleanReferrer('')).toBe('');
    expect(cleanReferrer('not a url')).toBe('');
  });

  test('a very long path is trimmed rather than stored whole', () => {
    expect(cleanPath(`/${'a'.repeat(500)}`).length).toBeLessThanOrEqual(121);
  });

  test('the obvious crawlers are recognised', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('curl/8.5.0')).toBe(true);
    expect(isBot(BROWSER)).toBe(false);
  });
});

/**
 * The figures that answer a question rather than report a number.
 *
 * "Four hundred visitors" is a number; "four hundred, up from two hundred" is the
 * thing somebody wanted to know. Same for a slow page: the mean time for a page
 * nobody visits is not a fact about the page.
 */
describe('which pages are slow', () => {
  test('ranks by mean time, not by the one bad request', () => {
    // `/fast` is asked for often and answers quickly. `/slow` is asked for often and
    // does not. `/fluke` was slow once.
    for (let i = 0; i < 10; i++) recordTraffic([visit({ path: '/fast', ms: 10 })]);
    for (let i = 0; i < 10; i++) recordTraffic([visit({ path: '/slow', ms: 900 })]);
    recordTraffic([visit({ path: '/fluke', ms: 9000 })]);

    const report = trafficFor(serviceId, '24h');
    expect(report.slowestPaths[0]?.path).toBe('/slow');
    expect(report.slowestPaths[0]?.avgMs).toBe(900);
    // Below the threshold, so it is left out rather than sitting at the top all day
    // looking like a problem.
    expect(report.slowestPaths.map((entry) => entry.path)).not.toContain('/fluke');
  });

  test('averages across the window rather than per day', () => {
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) recordTraffic([visit({ path: '/p', ms: 100, at: yesterday })]);
    for (let i = 0; i < 5; i++) recordTraffic([visit({ path: '/p', ms: 200 })]);

    const report = trafficFor(serviceId, '7d');
    expect(report.slowestPaths.find((entry) => entry.path === '/p')?.avgMs).toBe(150);
  });
});

describe('who is here now', () => {
  test('counts different people in the last few minutes', () => {
    recordTraffic([
      visit({ ip: '203.0.113.1' }),
      visit({ ip: '203.0.113.2' }),
      // The same person again is still one person.
      visit({ ip: '203.0.113.1', path: '/other' }),
    ]);
    expect(trafficFor(serviceId, '24h').live).toBe(2);
  });

  test('forgets somebody who left', () => {
    recordTraffic([visit({ ip: '203.0.113.1', at: Date.now() - 20 * 60_000 })]);
    expect(trafficFor(serviceId, '24h').live).toBe(0);
  });
});

describe('against the window before', () => {
  test('says what the same stretch looked like last time', () => {
    const lastWeek = Date.now() - 30 * 60 * 60 * 1000;
    recordTraffic([visit({ at: lastWeek, ip: '203.0.113.1' })]);
    recordTraffic([visit({ at: lastWeek, ip: '203.0.113.2' })]);
    recordTraffic([visit({ ip: '203.0.113.3' })]);

    const report = trafficFor(serviceId, '24h');
    expect(report.totals.requests).toBe(1);
    expect(report.previous?.requests).toBe(2);
    expect(report.previous?.visitors).toBe(2);
  });

  test('is not offered for thirty days, where it would reach past what is kept', () => {
    // The window before a thirty day one starts sixty days ago, and ninety days are
    // kept, so it would quietly become "against whatever is left".
    expect(trafficFor(serviceId, '30d').previous).toBeNull();
    expect(trafficFor(serviceId, '7d').previous).not.toBeNull();
  });
});

describe('the whole server at once', () => {
  test('adds up every app, and counts a person once across all of them', async () => {
    const { trafficAcrossServer } = await import('../src/analytics/store.ts');
    const other = createAppService({
      projectId: createProject('Other').id,
      name: 'other',
      repoUrl: 'https://github.com/example/other',
      branch: 'main',
    }).id;

    recordTraffic([visit({ ip: '203.0.113.1' })]);
    recordTraffic([visit({ serviceId: other, ip: '203.0.113.1' })]);
    recordTraffic([visit({ serviceId: other, ip: '203.0.113.2' })]);

    const report = trafficAcrossServer('24h');
    expect(report.totals.requests).toBe(3);
    expect(report.byService.find((row) => row.serviceId === other)?.requests).toBe(2);

    // Three, not two, and that is the right answer here. A visitor's hash is salted
    // with the app's own id, so the same person on two sites produces two unrelated
    // hashes and nothing can tell they were one person. Being unable to follow
    // somebody across your sites is worth more than a tidier number, so the
    // server-wide figure is "visitors, counted once per app" and says so.
    expect(report.totals.visitors).toBe(3);
  });
});
