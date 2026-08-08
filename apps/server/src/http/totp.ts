import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, by hand.
 *
 * One password guards a machine that can run anything, which makes the sign-in screen
 * the weakest sentence in a product whose pitch includes "your data, your machine".
 *
 * TOTP rather than passkeys to begin with: it is universal, it needs no hardware, and
 * it works with whatever authenticator somebody already has. The whole of RFC 6238 is
 * an HMAC and a base32 decoder, so pulling in a dependency to hold the key to a server
 * would be a poor trade.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** One step either side, so a phone whose clock is slightly off still works. */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = '';
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0');

  let out = '';
  for (let index = 0; index + 5 <= bits.length; index += 5) {
    out += BASE32[Number.parseInt(bits.slice(index, index + 5), 2)];
  }
  return out;
}

/** Base32 as authenticator apps write it: no padding, and case does not matter. */
export function decodeBase32(secret: string): Buffer | null {
  const clean = secret.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';

  for (const character of clean) {
    const value = BASE32.indexOf(character);
    if (value < 0) return null;
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

/** The code for one time step. */
export function codeFor(secret: string, step: number): string | null {
  const key = decodeBase32(secret);
  if (!key || key.length === 0) return null;

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // The offset lives in the low nibble of the last byte, which is what makes this
  // "dynamic truncation" rather than simply taking the first four bytes.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Whether a code is right, now.
 *
 * Compared with a constant-time comparison. The timing of a six-digit check is not
 * the most likely way into this server, but comparing secrets with `===` is the kind
 * of thing that is free to get right and embarrassing to get wrong.
 */
export function verifyCode(secret: string, code: string, at = Date.now()): boolean {
  return verifyCodeStep(secret, code, at) !== null;
}

/**
 * Which time step a code was right for, or null if it was not right at all.
 *
 * The step is what makes "this code, once" possible: the caller can remember the last
 * one somebody signed in with and refuse anything at or before it, so a code read over
 * a shoulder is good until the next tick and no further. A plain yes/no cannot express
 * that, because two different sign-ins a few seconds apart share the same yes.
 */
export function verifyCodeStep(secret: string, code: string, at = Date.now()): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;

  const step = Math.floor(at / 1000 / PERIOD_SECONDS);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const candidate = step + drift;
    const expected = codeFor(secret, candidate);
    if (!expected) return null;
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return candidate;
  }
  return null;
}

/** The URL behind the QR code every authenticator app scans. */
export function otpauthUrl(secret: string, email: string, issuer = 'Derailed'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * Codes for the day the phone is lost.
 *
 * Without these, turning on two-factor is a way to lock yourself out of your own
 * server permanently, and `derailed reset-password` on the box is the only way back.
 * That is a fine last resort and a terrible only one.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index++) {
    // Grouped for reading aloud and typing without losing your place.
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}
