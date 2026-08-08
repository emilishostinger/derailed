import type { UptimeDay, UptimeSummary } from '@derailed/shared';
import { raise } from '../alerts/notify.ts';
import { db } from '../db/index.ts';
import { allDomains, findDomain } from '../db/repo/domains.ts';
import { findService } from '../db/repo/services.ts';
import { publicPortSuffix } from '../proxy/caddy.ts';
import { newId } from '../util/ids.ts';
import { resolvesToBlockedAddress } from '../util/net.ts';

/**
 * Whether your sites are actually up.
 *
 * Derailed already knew whether a container was running, which is not the same
 * question and is not the one anybody is asking. A container can be running and
 * serving five hundreds; a certificate can have expired; a proxy can be pointed at
 * the wrong upstream. The only honest answer comes from making the same request a
 * visitor would.
 *
 * Uptime Kuma ships here as a one-click template, which is an admission that this
 * belongs in the product rather than beside it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** What a status page shows, and what "was it up last month" needs. */
const KEEP_MS = 90 * DAY_MS;

interface CheckRow {
  at: number;
  up: 0 | 1;
  status_code: number | null;
  ms: number | null;
  reason: string | null;
}

/**
 * One request, as a visitor would make it.
 *
 * A redirect counts as up: `example.com` redirecting to `www.example.com` is a site
 * that works. Anything from 200 to 399 is fine, and 401 too, because a site behind a
 * password is up and asking, not down.
 *
 * When the app's health check says the response must contain a text, the monitor
 * holds it to the same standard a deploy does: a 200 that no longer says the words
 * is an app serving its error page dressed as success, which is exactly the outage
 * a status code cannot see.
 */
export async function probe(
  url: string,
  expect?: string | null,
): Promise<{ up: boolean; status?: number; ms: number; reason?: string }> {
  const started = Date.now();
  try {
    // A monitor fetches a name somebody typed, on a timer, from inside the network the
    // apps and databases sit on. Without this a member could point a domain at
    // `169.254.169.254` or a neighbour's database port and read back, from the check's
    // result, whether it answered: a scanner for the one part of the network the panel
    // is meant to keep to itself. `redirect: 'manual'` below stops a public name from
    // walking us there in a second hop, and this stops the first one.
    if (await resolvesToBlockedAddress(new URL(url).hostname)) {
      return { up: false, ms: Date.now() - started, reason: 'could not be reached' };
    }
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Derailed/uptime' },
    });
    let up = response.status < 400 || response.status === 401;
    let reason = up ? undefined : `answered ${response.status}`;
    // Only read the body when there are words to look for; a redirect has no body
    // worth reading and a site behind a password will say its own thing.
    if (up && expect && response.status < 300) {
      const body = await response.text().catch(() => '');
      if (!body.includes(expect)) {
        up = false;
        reason = `answered, but never said "${expect}"`;
      }
    }
    const ms = Date.now() - started;
    return { up, status: response.status, ms, reason };
  } catch (err) {
    const ms = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    return {
      up: false,
      ms,
      reason: /timeout|timed out|abort/i.test(message)
        ? 'did not answer in time'
        : /certificate|ssl|tls/i.test(message)
          ? 'its certificate was refused'
          : 'could not be reached',
    };
  }
}

function record(
  domainId: string,
  result: { up: boolean; status?: number; ms: number; reason?: string },
): void {
  db()
    .query(
      'INSERT INTO uptime_checks (id, domain_id, at, up, status_code, ms, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      newId(),
      domainId,
      Date.now(),
      result.up ? 1 : 0,
      result.status ?? null,
      result.ms,
      result.reason ?? null,
    );
}

/** Checks one domain now. */
export async function checkNow(domainId: string): Promise<{ up: boolean; reason?: string }> {
  const domain = findDomain(domainId);
  if (!domain) return { up: false, reason: 'that address no longer exists' };

  const https = domain.tlsStatus === 'active';
  const url = `${https ? 'https' : 'http'}://${domain.hostname}${publicPortSuffix(https)}${
    domain.pathPrefix ?? '/'
  }`;

  const owner = domain.serviceId ? findService(domain.serviceId) : null;
  const expect = owner?.healthCheck === 'contains' ? owner.healthExpect : null;
  const result = await probe(url, expect);
  record(domainId, result);

  // Reported as its own thing rather than folded into the crash alerts: a container
  // that is running while its site answers nothing is exactly the case those miss.
  if (!result.up) {
    const service = owner;
    void raise({
      kind: 'app.crashed',
      subject: `uptime:${domainId}`,
      detail: result.reason,
      severity: 'critical',
      title: `${domain.hostname} is not answering`,
      body: `A request to it ${result.reason ?? 'failed'}.${
        service ? ` It should be served by ${service.name}.` : ''
      }`,
      action: 'The app may be running while its site is not, so its Logs tab is the place to look.',
    }).catch(() => undefined);
  }

  return { up: result.up, reason: result.reason };
}

/** Ninety days of up-or-down, a day at a time, for the bar on a status page. */
export function historyFor(domainId: string, days = 90): UptimeDay[] {
  const since = Date.now() - days * DAY_MS;
  const rows = db()
    .query<CheckRow, [string, number]>(
      'SELECT * FROM uptime_checks WHERE domain_id = ? AND at >= ? ORDER BY at',
    )
    .all(domainId, since);

  const byDay = new Map<number, { up: number; down: number; totalMs: number }>();
  for (const row of rows) {
    const day = Math.floor(row.at / DAY_MS) * DAY_MS;
    const entry = byDay.get(day) ?? { up: 0, down: 0, totalMs: 0 };
    if (row.up) entry.up++;
    else entry.down++;
    entry.totalMs += row.ms ?? 0;
    byDay.set(day, entry);
  }

  return [...byDay.entries()]
    .map(([day, entry]) => {
      const total = entry.up + entry.down;
      return {
        day,
        checks: total,
        // Rounded down deliberately: 99.94% should not be shown as 100%, because a
        // status page claiming perfection on a day something broke is worse than one
        // admitting a dip.
        uptimePercent: total ? Math.floor((entry.up / total) * 1000) / 10 : 0,
        averageMs: total ? Math.round(entry.totalMs / total) : 0,
      };
    })
    .sort((a, b) => a.day - b.day);
}

export function summaryFor(domainId: string): UptimeSummary {
  const days = historyFor(domainId);
  const latest = db()
    .query<CheckRow, [string]>(
      'SELECT * FROM uptime_checks WHERE domain_id = ? ORDER BY at DESC LIMIT 1',
    )
    .get(domainId);

  const totals = days.reduce(
    (sum, day) => ({
      checks: sum.checks + day.checks,
      up: sum.up + (day.checks * day.uptimePercent) / 100,
    }),
    { checks: 0, up: 0 },
  );

  return {
    domainId,
    up: latest ? latest.up === 1 : null,
    lastCheckedAt: latest?.at ?? null,
    lastReason: latest?.reason ?? null,
    days,
    uptimePercent: totals.checks ? Math.floor((totals.up / totals.checks) * 1000) / 10 : null,
  };
}

/** Every address worth checking: one somebody would actually visit. */
function watched() {
  return allDomains().filter((domain) => domain.serviceId && !domain.redirectTo);
}

async function sweep(): Promise<void> {
  for (const domain of watched()) {
    await checkNow(domain.id).catch(() => undefined);
  }
  db()
    .query('DELETE FROM uptime_checks WHERE at < ?')
    .run(Date.now() - KEEP_MS);
}

/** Every five minutes: often enough to notice, rare enough to be nothing at all. */
const INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startUptime(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref?.();
  // Not at boot: the apps are still starting, and a "down" recorded against a site
  // that had not come up yet is a false mark on a ninety-day bar that never goes away.
  setTimeout(() => void sweep(), 2 * 60 * 1000).unref?.();
}

export function stopUptime(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
