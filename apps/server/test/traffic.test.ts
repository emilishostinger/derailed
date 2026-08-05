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
  for (const table of ['traffic_hourly', 'traffic_visitors', 'traffic_paths', 'traffic_referrers'])
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
