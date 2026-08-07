import { db } from '../db/index.ts';
import { loadSecretKey } from '../util/crypto.ts';

/**
 * The figures, and nothing else.
 *
 * A visitor is an address hashed with a key that never leaves this server, and the
 * rows are deleted after 45 days. Enough to answer "how many people", never enough to
 * answer "which people", since the hash cannot be turned back into an address without
 * the key and there is nothing else about them stored at all.
 *
 * The hash deliberately does not include the date. Rotating it daily would be a
 * little more private and would also make one person visiting all week count as seven
 * visitors, which is the number most analytics quietly report and nobody believes.
 */
export interface TrafficEvent {
  serviceId: string;
  at: number;
  status: number;
  bytes: number;
  ms: number;
  path: string;
  referrer: string;
  userAgent: string;
  ip: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Kept for three months, then dropped. Long enough to see a season, short enough to stay small. */
const KEEP_DAYS = 90;

/** Distinct paths and referrers held per day, so one loose crawler can't bloat the table. */
const MAX_DISTINCT_PER_DAY = 500;

const BOT = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headlesschrome|curl|wget/i;

export function isBot(userAgent: string): boolean {
  return BOT.test(userAgent);
}

export function hourStart(at: number): number {
  return Math.floor(at / HOUR) * HOUR;
}

export function dayStart(at: number): number {
  return Math.floor(at / DAY) * DAY;
}

/** Only the path, and only so much of it: query strings carry tokens and names. */
export function cleanPath(uri: string): string {
  const path = uri.split('?')[0] ?? '/';
  return path.length > 120 ? `${path.slice(0, 120)}…` : path || '/';
}

/** The site someone came from, not the page: a referrer path is their business. */
export function cleanReferrer(referrer: string): string {
  if (!referrer) return '';
  try {
    const url = new URL(referrer);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function visitorHash(ip: string, serviceId: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`${serviceId}:${ip}`);
  hasher.update(loadSecretKey());
  return hasher.digest('hex').slice(0, 24);
}

export function recordTraffic(events: TrafficEvent[]): void {
  const database = db();
  const write = database.transaction((batch: TrafficEvent[]) => {
    for (const event of batch) {
      const hour = hourStart(event.at);
      const day = dayStart(event.at);
      const bot = isBot(event.userAgent);

      database
        .query(
          `INSERT INTO traffic_hourly
             (service_id, hour_start, requests, bots, bytes, ms_total,
              ok_2xx, redirect_3xx, client_4xx, server_5xx)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(service_id, hour_start) DO UPDATE SET
             requests     = requests + excluded.requests,
             bots         = bots + excluded.bots,
             bytes        = bytes + excluded.bytes,
             ms_total     = ms_total + excluded.ms_total,
             ok_2xx       = ok_2xx + excluded.ok_2xx,
             redirect_3xx = redirect_3xx + excluded.redirect_3xx,
             client_4xx   = client_4xx + excluded.client_4xx,
             server_5xx   = server_5xx + excluded.server_5xx`,
        )
        // Every counter here is about people, so a crawler adds to `bots` and to
        // nothing else. Mixing them meant the status breakdown added up to more than
        // the number of visits above it, which is the kind of arithmetic that makes
        // someone stop believing the whole page.
        .run(
          event.serviceId,
          hour,
          bot ? 0 : 1,
          bot ? 1 : 0,
          bot ? 0 : event.bytes,
          bot ? 0 : event.ms,
          !bot && event.status >= 200 && event.status < 300 ? 1 : 0,
          !bot && event.status >= 300 && event.status < 400 ? 1 : 0,
          !bot && event.status >= 400 && event.status < 500 ? 1 : 0,
          !bot && event.status >= 500 ? 1 : 0,
        );

      // Everything below is about people, so crawlers are left out of it.
      if (bot) continue;

      if (event.ip) {
        const who = visitorHash(event.ip, event.serviceId);
        database
          .query(
            'INSERT OR IGNORE INTO traffic_visitors (service_id, hour_start, visitor_hash) VALUES (?, ?, ?)',
          )
          .run(event.serviceId, hour, who);
        // The same person again, by the minute, so "who is here now" has an answer.
        // Swept away after an hour: this table is for the last few minutes only.
        database
          .query(
            'INSERT OR IGNORE INTO traffic_live (service_id, minute_start, visitor_hash) VALUES (?, ?, ?)',
          )
          .run(event.serviceId, Math.floor(event.at / 60_000) * 60_000, who);
      }

      bumpTop('traffic_paths', 'path', event.serviceId, day, cleanPath(event.path), event.ms);

      const referrer = cleanReferrer(event.referrer);
      if (referrer) bumpTop('traffic_referrers', 'referrer', event.serviceId, day, referrer);
    }
  });

  write(events);
}

/**
 * Adds one to a per-day tally, unless the day has already seen too many distinct
 * values. A crawler walking a million generated URLs should cost a bounded amount of
 * disk, and the tail beyond the first few hundred is never shown anyway.
 */
function bumpTop(
  table: 'traffic_paths' | 'traffic_referrers',
  column: 'path' | 'referrer',
  serviceId: string,
  day: number,
  value: string,
  /** Only paths carry a time. A referrer is a place, not a request. */
  ms = 0,
): void {
  const database = db();
  const existing = database
    .query<{ requests: number }, [string, number, string]>(
      `SELECT requests FROM ${table} WHERE service_id = ? AND day_start = ? AND ${column} = ?`,
    )
    .get(serviceId, day, value);

  if (existing) {
    database
      .query(
        `UPDATE ${table} SET requests = requests + 1${
          table === 'traffic_paths' ? ', ms_total = ms_total + ?' : ''
        } WHERE service_id = ? AND day_start = ? AND ${column} = ?`,
      )
      .run(...(table === 'traffic_paths' ? [ms] : []), serviceId, day, value);
    return;
  }

  const { count } = database
    .query<{ count: number }, [string, number]>(
      `SELECT COUNT(*) as count FROM ${table} WHERE service_id = ? AND day_start = ?`,
    )
    .get(serviceId, day) ?? { count: 0 };
  if (count >= MAX_DISTINCT_PER_DAY) return;

  if (table === 'traffic_paths') {
    database
      .query(
        'INSERT INTO traffic_paths (service_id, day_start, path, requests, ms_total) VALUES (?, ?, ?, 1, ?)',
      )
      .run(serviceId, day, value, ms);
    return;
  }
  database
    .query(`INSERT INTO ${table} (service_id, day_start, ${column}, requests) VALUES (?, ?, ?, 1)`)
    .run(serviceId, day, value);
}

/** How many different people have asked for anything in the last few minutes. */
export function liveVisitors(serviceId?: string): number {
  const since = Date.now() - 5 * 60_000;
  const row = serviceId
    ? db()
        .query<{ visitors: number }, [string, number]>(
          'SELECT COUNT(DISTINCT visitor_hash) AS visitors FROM traffic_live WHERE service_id = ? AND minute_start >= ?',
        )
        .get(serviceId, since)
    : db()
        .query<{ visitors: number }, [number]>(
          'SELECT COUNT(DISTINCT visitor_hash) AS visitors FROM traffic_live WHERE minute_start >= ?',
        )
        .get(since);
  return row?.visitors ?? 0;
}

export function pruneTraffic(): void {
  const cutoffHour = hourStart(Date.now() - KEEP_DAYS * DAY);
  const cutoffDay = dayStart(Date.now() - KEEP_DAYS * DAY);
  db().query('DELETE FROM traffic_hourly WHERE hour_start < ?').run(cutoffHour);
  db().query('DELETE FROM traffic_paths WHERE day_start < ?').run(cutoffDay);
  db().query('DELETE FROM traffic_referrers WHERE day_start < ?').run(cutoffDay);
  // Visitor rows are the only ones that could ever be linked back to a person, even
  // hashed, so they go sooner than the rest.
  db()
    .query('DELETE FROM traffic_visitors WHERE hour_start < ?')
    .run(hourStart(Date.now() - 45 * DAY));
  // An hour rather than a day: nothing reads past five minutes, and the rest is a
  // row per person per minute, which is the fastest-growing table here.
  db()
    .query('DELETE FROM traffic_live WHERE minute_start < ?')
    .run(Date.now() - 60 * 60_000);
}

export interface TrafficPoint {
  at: number;
  requests: number;
  visitors: number;
  errors: number;
}

export interface TrafficReport {
  range: '24h' | '7d' | '30d';
  /** Bucketed by hour for a day, by day for anything longer. */
  points: TrafficPoint[];
  totals: {
    requests: number;
    visitors: number;
    bots: number;
    bytes: number;
    /** Mean response time in milliseconds, as the proxy measured it. */
    avgMs: number;
    ok: number;
    redirects: number;
    clientErrors: number;
    serverErrors: number;
  };
  topPaths: { path: string; requests: number }[];
  topReferrers: { referrer: string; requests: number }[];
  /**
   * The pages people wait longest for, by mean time.
   *
   * Only pages asked for enough times to mean anything: one slow request to a page
   * nobody visits is a coincidence, and it would otherwise sit at the top of this
   * list for a day looking like a problem.
   */
  slowestPaths: { path: string; requests: number; avgMs: number }[];
  /** Different people in the last five minutes. */
  live: number;
  /**
   * The same figures for the window before this one, so the screen can say whether
   * things are going up. Absent for 30d, where the comparison would reach past the
   * ninety days of data that are kept.
   */
  previous: { requests: number; visitors: number; avgMs: number } | null;
  /** True until the first request has ever been recorded for this app. */
  empty: boolean;
}

/** Below this, a page's mean time is one bad afternoon rather than a property of it. */
const SLOW_PAGE_MINIMUM = 5;

const RANGES = {
  '24h': { since: () => Date.now() - DAY, bucket: HOUR },
  '7d': { since: () => Date.now() - 7 * DAY, bucket: DAY },
  '30d': { since: () => Date.now() - 30 * DAY, bucket: DAY },
} as const;

export function trafficFor(serviceId: string, range: keyof typeof RANGES): TrafficReport {
  const { since, bucket } = RANGES[range];
  const from = Math.floor(since() / bucket) * bucket;

  const rows = db()
    .query<
      {
        hour_start: number;
        requests: number;
        bots: number;
        bytes: number;
        ms_total: number;
        ok_2xx: number;
        redirect_3xx: number;
        client_4xx: number;
        server_5xx: number;
      },
      [string, number]
    >(`SELECT * FROM traffic_hourly WHERE service_id = ? AND hour_start >= ? ORDER BY hour_start`)
    .all(serviceId, from);

  const visitorRows = db()
    .query<{ bucket: number; visitors: number }, [number, number, string, number]>(
      `SELECT (hour_start / ?) * ? AS bucket, COUNT(DISTINCT visitor_hash) AS visitors
         FROM traffic_visitors WHERE service_id = ? AND hour_start >= ?
        GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucket, bucket, serviceId, from);

  const visitorsByBucket = new Map(visitorRows.map((row) => [row.bucket, row.visitors]));

  const buckets = new Map<number, TrafficPoint>();
  for (let at = from; at <= Date.now(); at += bucket) {
    buckets.set(at, { at, requests: 0, visitors: visitorsByBucket.get(at) ?? 0, errors: 0 });
  }

  const totals = {
    requests: 0,
    visitors: 0,
    bots: 0,
    bytes: 0,
    avgMs: 0,
    ok: 0,
    redirects: 0,
    clientErrors: 0,
    serverErrors: 0,
  };
  let msTotal = 0;

  for (const row of rows) {
    const at = Math.floor(row.hour_start / bucket) * bucket;
    const point = buckets.get(at);
    if (point) {
      point.requests += row.requests;
      point.errors += row.client_4xx + row.server_5xx;
    }
    totals.requests += row.requests;
    totals.bots += row.bots;
    totals.bytes += row.bytes;
    totals.ok += row.ok_2xx;
    totals.redirects += row.redirect_3xx;
    totals.clientErrors += row.client_4xx;
    totals.serverErrors += row.server_5xx;
    msTotal += row.ms_total;
  }

  totals.avgMs = totals.requests > 0 ? Math.round(msTotal / totals.requests) : 0;

  // Distinct across the whole window, not the sum of the buckets: one person visiting
  // every day is one person, and adding up daily figures would say otherwise.
  const distinct = db()
    .query<{ visitors: number }, [string, number]>(
      'SELECT COUNT(DISTINCT visitor_hash) AS visitors FROM traffic_visitors WHERE service_id = ? AND hour_start >= ?',
    )
    .get(serviceId, from);
  totals.visitors = distinct?.visitors ?? 0;

  const fromDay = dayStart(from);
  const topPaths = db()
    .query<{ path: string; requests: number }, [string, number]>(
      `SELECT path, SUM(requests) AS requests FROM traffic_paths
        WHERE service_id = ? AND day_start >= ?
        GROUP BY path ORDER BY requests DESC LIMIT 10`,
    )
    .all(serviceId, fromDay);

  const topReferrers = db()
    .query<{ referrer: string; requests: number }, [string, number]>(
      `SELECT referrer, SUM(requests) AS requests FROM traffic_referrers
        WHERE service_id = ? AND day_start >= ?
        GROUP BY referrer ORDER BY requests DESC LIMIT 10`,
    )
    .all(serviceId, fromDay);

  // The `HAVING` is the whole point. Without it the slowest page is whichever one
  // somebody hit once while the server was busy, which is not a fact about the page.
  const slowestPaths = db()
    .query<{ path: string; requests: number; avgMs: number }, [string, number]>(
      `SELECT path, SUM(requests) AS requests,
              CAST(SUM(ms_total) / SUM(requests) AS INTEGER) AS avgMs
         FROM traffic_paths
        WHERE service_id = ? AND day_start >= ?
        GROUP BY path HAVING SUM(requests) >= ${SLOW_PAGE_MINIMUM}
        ORDER BY avgMs DESC LIMIT 10`,
    )
    .all(serviceId, fromDay);

  const ever = db()
    .query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM traffic_hourly WHERE service_id = ?',
    )
    .get(serviceId);

  return {
    range,
    points: [...buckets.values()],
    totals,
    topPaths,
    topReferrers,
    slowestPaths,
    live: liveVisitors(serviceId),
    previous: previousWindow(serviceId, range, from),
    empty: (ever?.count ?? 0) === 0,
  };
}

/**
 * The same window, one window earlier.
 *
 * "Four hundred visitors" is a number. "Four hundred, up from two hundred and ten" is
 * the thing somebody actually wanted to know, and it is the difference between a page
 * you glance at and one you act on.
 *
 * Not offered for 30d: the window before that starts sixty days ago, and only ninety
 * days are kept, so the comparison would quietly become "against whatever is left".
 */
function previousWindow(
  serviceId: string,
  range: keyof typeof RANGES,
  from: number,
): TrafficReport['previous'] {
  if (range === '30d') return null;
  const span = Date.now() - from;
  const start = from - span;

  const row = db()
    .query<{ requests: number; ms: number }, [string, number, number]>(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(ms_total), 0) AS ms
         FROM traffic_hourly WHERE service_id = ? AND hour_start >= ? AND hour_start < ?`,
    )
    .get(serviceId, start, from);

  const visitors = db()
    .query<{ visitors: number }, [string, number, number]>(
      `SELECT COUNT(DISTINCT visitor_hash) AS visitors FROM traffic_visitors
        WHERE service_id = ? AND hour_start >= ? AND hour_start < ?`,
    )
    .get(serviceId, start, from);

  const requests = row?.requests ?? 0;
  return {
    requests,
    visitors: visitors?.visitors ?? 0,
    avgMs: requests > 0 ? Math.round((row?.ms ?? 0) / requests) : 0,
  };
}

/**
 * Everything on the server, added up.
 *
 * "Is the machine busy" is a different question from "how is this app doing", and
 * answering it previously meant opening every app in turn and adding up by eye.
 */
export function trafficAcrossServer(range: keyof typeof RANGES): {
  range: keyof typeof RANGES;
  totals: {
    requests: number;
    /** Counted once per app: see the note in the query. An upper bound, on purpose. */
    visitors: number;
    bots: number;
    bytes: number;
    avgMs: number;
  };
  live: number;
  byService: { serviceId: string; requests: number; visitors: number }[];
} {
  const { since } = RANGES[range];
  const from = since();

  const totals = db()
    .query<{ requests: number; bots: number; bytes: number; ms: number }, [number]>(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(bots), 0) AS bots,
              COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(ms_total), 0) AS ms
         FROM traffic_hourly WHERE hour_start >= ?`,
    )
    .get(from);

  // An upper bound, and deliberately so.
  //
  // A visitor's hash is salted with the app's own id, which means the same person on
  // two of your sites produces two unrelated hashes and there is no way to tell it
  // was one person. That is the point: being unable to follow somebody across your
  // sites is a property worth more than a tidier number here. So this counts distinct
  // hashes, which is "visitors, counted once per app", and the screen says so rather
  // than implying a precision that the storage cannot support.
  const visitors = db()
    .query<{ visitors: number }, [number]>(
      'SELECT COUNT(DISTINCT visitor_hash) AS visitors FROM traffic_visitors WHERE hour_start >= ?',
    )
    .get(from);

  const byService = db()
    .query<{ serviceId: string; requests: number; visitors: number }, [number, number]>(
      `SELECT h.service_id AS serviceId, SUM(h.requests) AS requests,
              (SELECT COUNT(DISTINCT v.visitor_hash) FROM traffic_visitors v
                WHERE v.service_id = h.service_id AND v.hour_start >= ?) AS visitors
         FROM traffic_hourly h WHERE h.hour_start >= ?
        GROUP BY h.service_id ORDER BY requests DESC`,
    )
    .all(from, from);

  const requests = totals?.requests ?? 0;
  return {
    range,
    totals: {
      requests,
      visitors: visitors?.visitors ?? 0,
      bots: totals?.bots ?? 0,
      bytes: totals?.bytes ?? 0,
      avgMs: requests > 0 ? Math.round((totals?.ms ?? 0) / requests) : 0,
    },
    live: liveVisitors(),
    byService,
  };
}
