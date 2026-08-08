import { lookup } from 'node:dns/promises';

/**
 * Whose word to take for a request's origin.
 *
 * `X-Forwarded-For` and `X-Forwarded-Proto` are just headers: anyone talking to
 * Derailed directly can write whatever they like in them. They are only worth reading
 * when the connection itself came from something we put in front of ourselves, which
 * on this machine means the Caddy container reaching back through the host gateway.
 * Everything else is a stranger describing themselves.
 */

/** Loopback, RFC1918, and the Docker bridges Caddy sits on. */
export function isPrivateAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  // Bun reports IPv4-mapped IPv6 for a dual-stack listener.
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');

  if (value === '::1' || value === 'localhost') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true;

  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * The address to hold a request against.
 *
 * A rate limiter keyed on a header the caller writes is not a rate limiter: sixty
 * password guesses with sixty made-up `X-Forwarded-For` values were sixty separate
 * callers as far as it was concerned, so the five-a-minute cap never once fired.
 *
 * The socket address is the one thing a caller cannot choose, so that is the key,
 * unless the socket itself belongs to our own proxy, in which case the header it added
 * is the only way to see past it.
 */
export function resolveClientIp(peer: string | null | undefined, forwarded: string | null): string {
  if (!peer) {
    // We were not told who is on the other end, so there is nothing to check the
    // header against. One shared bucket: throttling too much is the safe direction to
    // be wrong in, and this is a panel with a single admin on it.
    return 'local';
  }
  if (!isPrivateAddress(peer)) return peer;

  // The socket belongs to our own proxy, so the forwarded header is the only way to see
  // the real caller. But the *last* public entry, not the first. Caddy appends the
  // address it actually saw to whatever `X-Forwarded-For` arrived, so a caller who sends
  // `X-Forwarded-For: 6.6.6.6` turns it into `6.6.6.6, <their real address>`: the first
  // value is theirs to invent and the last is the one Caddy vouched for. Taking the
  // leftmost handed every password guess a fresh identity again, the exact hole this
  // function exists to close. Private hops on the tail (the docker bridge) are stepped
  // over, so the answer is the outermost address our own side is willing to stand behind.
  const hops = (forwarded ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isPrivateAddress(hops[i])) return hops[i]!;
  }
  return peer;
}

/**
 * Whether an address is one this server must not be talked into fetching.
 *
 * A separate question from `isPrivateAddress`, and deliberately a separate function.
 * That one answers "did this connection come from our own proxy", and widening it
 * would mean believing `X-Forwarded-For` from more places, which is the opposite of
 * what anybody wants. This one answers "would fetching this reach something only we
 * can reach", and it wants to be as wide as possible.
 *
 * Everything `isPrivateAddress` covers, plus the ranges that only matter when the
 * server is the one making the request: the unspecified address, carrier-grade NAT,
 * the benchmarking and documentation blocks, multicast, and the reserved top of the
 * space. All of them are ways to name something that is not on the public internet.
 */
export function isBlockedFetchAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '');

  if (isPrivateAddress(value)) return true;

  // IPv6: the unspecified address, and anything multicast.
  if (value === '::' || value === '0:0:0:0:0:0:0:0') return true;
  if (/^ff[0-9a-f]{2}:/.test(value)) return true;

  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const [a, b] = octets as [number, number, number, number];
  // "This network", which on Linux is another way of writing loopback.
  if (a === 0) return true;
  // Carrier-grade NAT, 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // IETF protocol assignments, 192.0.0.0/24.
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  // Benchmarking, 198.18.0.0/15.
  if (a === 198 && (b === 18 || b === 19)) return true;
  // Multicast and the reserved block above it, which includes 255.255.255.255.
  if (a >= 224) return true;
  return false;
}

/** Same rule for the scheme, which decides whether the session cookie is `Secure`. */
export function resolveHttps(
  peer: string | null | undefined,
  forwardedProto: string | null,
  urlProtocol: string,
): boolean {
  if (forwardedProto && peer && isPrivateAddress(peer)) {
    return forwardedProto.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  return urlProtocol === 'https:';
}

/** Thrown when a URL names something on this machine or this network. */
export class BlockedAddressError extends Error {
  constructor(message = 'That address is not one this server will fetch.') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

/**
 * Whether a hostname, once resolved, lands anywhere we refuse to go.
 *
 * The name is resolved rather than pattern-matched, because `internal.example.com`
 * is a perfectly ordinary name that happens to answer `10.0.0.5`, and checking the
 * text of a URL would let it straight through.
 */
export async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  // A literal address needs no lookup, and asking the resolver about one is a way to
  // get a different answer than the one the socket will use.
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) return isBlockedFetchAddress(bare);

  try {
    const answers = await lookup(bare, { all: true });
    // Every answer, not the first: a name that returns one public address and one
    // private one is the oldest way around a check like this.
    return answers.length === 0 || answers.some((answer) => isBlockedFetchAddress(answer.address));
  } catch {
    // A name that will not resolve cannot be fetched either, and refusing is the
    // safe direction to be wrong in.
    return true;
  }
}

/**
 * `fetch`, for a URL somebody else chose.
 *
 * Two things the plain one will not do. It checks where the name actually points
 * before connecting, so the panel cannot be pointed at the cloud metadata service,
 * at a database on the same Docker bridge, or at itself. And it follows redirects by
 * hand, checking every hop, because `redirect: 'follow'` would take a permitted first
 * address to a forbidden second one, and would happily walk from `https` down to plain
 * `http` on the way, which turned the scheme check into decoration.
 */
export async function fetchPublic(
  url: string | URL,
  init: RequestInit = {},
  options: { protocols?: string[]; maxRedirects?: number } = {},
): Promise<Response> {
  const protocols = options.protocols ?? ['https:', 'http:'];
  const maxRedirects = options.maxRedirects ?? 5;

  let current = new URL(String(url));

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!protocols.includes(current.protocol)) {
      throw new BlockedAddressError(
        hop === 0
          ? `Only ${protocols.map((p) => p.replace(':', '')).join(' and ')} addresses are fetched.`
          : 'That address redirected somewhere this server will not follow.',
      );
    }
    if (await resolvesToBlockedAddress(current.hostname)) {
      throw new BlockedAddressError(
        'That address points at this machine or its private network, so it is not fetched.',
      );
    }

    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    // Cancelled rather than left hanging: the body of a redirect is not wanted and an
    // unread one holds the connection open.
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current);
  }

  throw new BlockedAddressError('That address redirected too many times.');
}
