import type { DnsStatus } from '@derailed/shared';

/**
 * DNS checks go through DNS-over-HTTPS rather than the system resolver: VPS
 * resolvers are often stale, split-horizon, or configured to answer for the
 * machine's own hostname, all of which would give the user wrong advice.
 */
const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

export interface DnsCheck {
  status: DnsStatus;
  /** Addresses the hostname actually resolves to, for the "points somewhere else" case. */
  addresses: string[];
}

async function ask(
  resolver: string,
  hostname: string,
  type: 'A' | 'AAAA',
): Promise<DohResponse | null> {
  try {
    const url = new URL(resolver);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    return (await response.json()) as DohResponse;
  } catch {
    return null;
  }
}

/**
 * Asks every resolver, and believes the one that found something.
 *
 * A resolver that was asked before the record existed remembers "no such name" for as
 * long as the zone's SOA says, often ten minutes. Taking the first answer meant one
 * stale cache told someone their brand new record did not exist, right after they had
 * created it. Any positive answer settles it: nothing invents an A record.
 */
async function query(hostname: string, type: 'A' | 'AAAA'): Promise<DohResponse | null> {
  const answers = await Promise.all(RESOLVERS.map((resolver) => ask(resolver, hostname, type)));
  const found = answers.find((answer) =>
    answer?.Answer?.some((entry) => entry.type === 1 || entry.type === 28),
  );
  return found ?? answers.find((answer) => answer !== null) ?? null;
}

export async function checkDns(hostname: string, expectedIp: string): Promise<DnsCheck> {
  const [v4, v6] = await Promise.all([query(hostname, 'A'), query(hostname, 'AAAA')]);
  if (!v4 && !v6) return { status: 'unchecked', addresses: [] };

  // Type 1 = A, 28 = AAAA; anything else in the chain is a CNAME hop we can ignore.
  const addresses = [...(v4?.Answer ?? []), ...(v6?.Answer ?? [])]
    .filter((answer) => answer.type === 1 || answer.type === 28)
    .map((answer) => answer.data.trim());

  if (!addresses.length) return { status: 'no_record', addresses: [] };
  if (addresses.includes(expectedIp)) return { status: 'ok', addresses };
  return { status: 'wrong_ip', addresses };
}

/**
 * Confirms the certificate is live by asking the internet-facing address, which is
 * the same thing the visitor's browser will do.
 */
export async function checkHttps(hostname: string, port = 443): Promise<boolean> {
  const suffix = port === 443 ? '' : `:${port}`;
  try {
    const response = await fetch(`https://${hostname}${suffix}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

/** apex + www helper: example.com → www.example.com (and never www.www.…). */
export function wwwVariant(hostname: string): string | null {
  if (hostname.startsWith('www.')) return null;
  // Only offer it for an apex domain: app.example.com doesn't want www.app.example.com.
  return hostname.split('.').length === 2 ? `www.${hostname}` : null;
}
