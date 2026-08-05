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

  const first = forwarded?.split(',')[0]?.trim();
  return first || peer;
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
