import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { allDomains } from '../db/repo/domains.ts';
import { anythingExpired, currentModes, observeTraffic, sweepBotGuard } from '../proxy/botguard.ts';
import { recordTraffic, type TrafficEvent } from './store.ts';

/**
 * Where the traffic figures come from.
 *
 * Caddy already sees every request, so it writes one JSON line per request to a file
 * and Derailed reads the new bytes every few seconds. No script in anyone's pages, no
 * third party, nothing following your visitors around the internet.
 *
 * The lines themselves are never kept. Each one is turned into counters and a hashed
 * visitor id and then forgotten, so what remains cannot be turned back into a list of
 * who read what.
 */
const LOG_FILE = join(paths.accessLogs, 'access.log');
const INTERVAL_MS = 15_000;

interface AccessLine {
  ts?: number;
  msg?: string;
  request?: {
    remote_ip?: string;
    client_ip?: string;
    host?: string;
    method?: string;
    uri?: string;
    headers?: Record<string, string[]>;
  };
  duration?: number;
  size?: number;
  status?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** How far into the file we have read. Reset when the file is rolled or truncated. */
let offset = 0;
let partial = '';

export function startTrafficCollector(): void {
  if (timer) return;
  timer = setInterval(() => void drain(), INTERVAL_MS);
  timer.unref?.();
  void drain();
}

export function stopTrafficCollector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function drain(): Promise<void> {
  const info = await stat(LOG_FILE).catch(() => null);
  if (!info) return;

  // Caddy rolls the file when it gets big. A file smaller than where we were reading
  // is a new one, so start again rather than skipping the first half of it.
  if (info.size < offset) {
    offset = 0;
    partial = '';
  }
  if (info.size === offset) return;

  const chunk = await Bun.file(LOG_FILE)
    .slice(offset, info.size)
    .text()
    .catch(() => '');
  offset = info.size;
  if (!chunk) return;

  const text = partial + chunk;
  const lines = text.split('\n');
  // The last piece may be half a line, whatever Caddy had written when we looked.
  partial = lines.pop() ?? '';

  const hosts = hostToService();
  const events: TrafficEvent[] = [];

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let entry: AccessLine;
    try {
      entry = JSON.parse(line) as AccessLine;
    } catch {
      continue;
    }
    if (entry.msg !== 'handled request') continue;

    const host = (entry.request?.host ?? '').split(':')[0]!.toLowerCase();
    const serviceId = hosts.get(host);
    if (!serviceId) continue;

    const headers = entry.request?.headers ?? {};
    events.push({
      serviceId,
      at: entry.ts ? entry.ts * 1000 : Date.now(),
      status: entry.status ?? 0,
      bytes: entry.size ?? 0,
      ms: Math.round((entry.duration ?? 0) * 1000),
      path: entry.request?.uri ?? '/',
      referrer: headers.Referer?.[0] ?? headers.referer?.[0] ?? '',
      userAgent: headers['User-Agent']?.[0] ?? headers['user-agent']?.[0] ?? '',
      ip: entry.request?.client_ip ?? entry.request?.remote_ip ?? '',
    });
  }

  if (events.length) recordTraffic(events);

  // The same lines feed the bot walls: an address hammering an app that asked
  // for protection is challenged or refused, and a wall whose time has run out
  // comes down again. Both mean pushing fresh routes.
  const wentUp = events.length ? observeTraffic(events, currentModes()) : false;
  const cameDown = anythingExpired();
  if (cameDown) sweepBotGuard();
  if (wentUp || cameDown) {
    const { syncRoutes } = await import('../proxy/sync.ts');
    await syncRoutes().catch(() => undefined);
  }
}

/** Which app answers on which hostname, so a line can be attributed at all. */
function hostToService(): Map<string, string> {
  const map = new Map<string, string>();
  for (const domain of allDomains()) {
    if (domain.serviceId) map.set(domain.hostname.toLowerCase(), domain.serviceId);
  }
  return map;
}
