import type { Context } from 'hono';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { randomSecret } from '../util/crypto.ts';
import { isPrivateAddress } from '../util/net.ts';

/**
 * Proving a request really came through our own proxy.
 *
 * The public endpoints (forms, the bot challenge, app login) trust two headers
 * the proxy attaches: which service the request is for, and who the visitor is.
 * That trust is safe only when the header could not have been written by the
 * visitor, and on a standard install the panel's own port is open to the
 * internet, so a request straight to it carries whatever headers the attacker
 * pleased.
 *
 * The fix is a secret that lives only inside the Caddy configuration Derailed
 * writes: the proxy stamps it on exactly the internal routes that reach these
 * endpoints, and a request that did not pass through one of those routes cannot
 * have it. It never leaves the box and never reaches a browser.
 */

export const PROXY_HEADER = 'x-derailed-proxy';

export function proxySecret(): string {
  let secret = getSetting(SETTINGS.proxySecret);
  if (!secret) {
    secret = randomSecret(32);
    setSetting(SETTINGS.proxySecret, secret);
  }
  return secret;
}

/** Whether this request was stamped by our proxy, in constant time. */
export function fromProxy(c: Context): boolean {
  const supplied = c.req.header(PROXY_HEADER) ?? '';
  const expected = proxySecret();
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The visitor's real address, given the request came through the proxy.
 *
 * Caddy appends the address it actually saw to whatever `X-Forwarded-For`
 * arrived, so the value the visitor invented sits at the front and the one the
 * proxy vouched for sits at the back. The rightmost public hop is the answer;
 * the leftmost is a fresh identity for every guess, which is the whole point of
 * not reading it. Private tail hops (the docker bridge) are stepped over.
 */
export function forwardedClientIp(c: Context): string {
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isPrivateAddress(hops[i])) return hops[i]!;
  }
  return hops[0] ?? 'unknown';
}
