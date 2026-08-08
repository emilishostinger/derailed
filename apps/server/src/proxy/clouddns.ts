import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { decrypt, encrypt } from '../util/crypto.ts';

/**
 * DNS records, written for you.
 *
 * The single biggest onboarding friction left: everything after "point your domain
 * at this server" is Derailed's job, and that one sentence sends people to a DNS
 * screen they have never seen to type a record kind they have never heard of.
 * Connect Cloudflare once (a token with DNS edit rights), and the A record, the
 * www CNAME and, if asked, the wildcard write themselves.
 *
 * Cloudflare first because it holds the most zones people actually have; the shape
 * here (list zones, upsert records) is the same everywhere sane, so others can
 * follow behind the same screen.
 *
 * Records are written DNS-only (grey cloud), deliberately: with the orange cloud
 * on, Let's Encrypt's check reaches Cloudflare instead of this server and the
 * certificate never arrives. That is not a caveat in a doc; it is the setting.
 */

/** Read per call, not at import: the tests point this at a pretend Cloudflare. */
const api = () => process.env.DERAILED_CLOUDFLARE_API ?? 'https://api.cloudflare.com/client/v4';

export class DnsProviderError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export function hasDnsToken(): boolean {
  return !!getSetting(SETTINGS.cloudflareToken);
}

/** Write-only, like every other credential: stored encrypted, never sent back. */
export function setDnsToken(token: string | null): void {
  setSetting(SETTINGS.cloudflareToken, token ? encrypt(token) : '');
}

function token(): string {
  const stored = getSetting(SETTINGS.cloudflareToken);
  if (!stored) {
    throw new DnsProviderError(
      'Cloudflare is not connected yet.',
      'Paste an API token with DNS edit rights on the Domains page.',
    );
  }
  return decrypt(stored);
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { message?: string }[];
  result?: T;
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${api()}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DnsProviderError('Cloudflare could not be reached.');
  }
  const body = (await response.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!body?.success) {
    const why = body?.errors?.[0]?.message ?? `it answered ${response.status}`;
    throw new DnsProviderError(
      `Cloudflare refused: ${why}.`,
      response.status === 403 || response.status === 401
        ? 'Check the token has Zone.DNS edit rights and has not expired.'
        : undefined,
    );
  }
  return body.result as T;
}

export interface DnsZone {
  id: string;
  name: string;
}

export async function listZones(): Promise<DnsZone[]> {
  const zones = await cf<{ id: string; name: string }[]>('/zones?per_page=50&status=active');
  return zones.map((zone) => ({ id: zone.id, name: zone.name }));
}

/** The zone a hostname belongs to: the longest zone name it ends with. */
export function zoneFor(hostname: string, zones: DnsZone[]): DnsZone | null {
  const lower = hostname.toLowerCase();
  return (
    zones
      .filter((zone) => lower === zone.name || lower.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

/** One record, made true: created when absent, corrected when it says something else. */
async function upsert(
  zoneId: string,
  record: { type: 'A' | 'CNAME'; name: string; content: string },
): Promise<'created' | 'updated' | 'kept'> {
  const existing = await cf<CfRecord[]>(
    `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
  );
  const body = JSON.stringify({
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: 1,
    // Grey cloud. With Cloudflare in front, Let's Encrypt's check never reaches
    // this server and the certificate never arrives.
    proxied: false,
  });
  const found = existing[0];
  if (found) {
    if (found.content === record.content) return 'kept';
    await cf(`/zones/${zoneId}/dns_records/${found.id}`, { method: 'PUT', body });
    return 'updated';
  }
  await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body });
  return 'created';
}

export interface DnsWriteResult {
  zone: string;
  records: { name: string; type: string; content: string; outcome: string }[];
}

/**
 * The records a hostname needs, written.
 *
 * An apex gets the A record, the www CNAME pointing at it, and the wildcard when
 * asked (which is what makes every future app's generated name real). A subdomain
 * gets just its own A record, because writing more than was asked for is how DNS
 * surprises happen.
 */
export async function writeRecordsFor(
  hostname: string,
  serverIp: string,
  options: { wildcard?: boolean } = {},
): Promise<DnsWriteResult> {
  const zones = await listZones();
  const zone = zoneFor(hostname, zones);
  if (!zone) {
    throw new DnsProviderError(
      `None of the connected Cloudflare zones holds ${hostname}.`,
      `The token can see: ${zones.map((entry) => entry.name).join(', ') || 'no zones at all'}.`,
    );
  }

  const wanted: { type: 'A' | 'CNAME'; name: string; content: string }[] = [];
  if (hostname === zone.name) {
    wanted.push({ type: 'A', name: zone.name, content: serverIp });
    wanted.push({ type: 'CNAME', name: `www.${zone.name}`, content: zone.name });
    if (options.wildcard) wanted.push({ type: 'A', name: `*.${zone.name}`, content: serverIp });
  } else {
    wanted.push({ type: 'A', name: hostname, content: serverIp });
  }

  const records: DnsWriteResult['records'] = [];
  for (const record of wanted) {
    const outcome = await upsert(zone.id, record);
    records.push({ ...record, outcome });
  }
  return { zone: zone.name, records };
}
