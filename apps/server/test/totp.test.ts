import { describe, expect, test } from 'bun:test';
import {
  codeFor,
  decodeBase32,
  generateRecoveryCodes,
  generateSecret,
  otpauthUrl,
  verifyCode,
} from '../src/http/totp.ts';

/**
 * The second factor.
 *
 * Written by hand, so the first thing to establish is that it is actually TOTP and not
 * something that merely looks like it. RFC 6238 publishes test vectors: a known
 * secret, known times, known codes. If those pass, every authenticator app in the
 * world agrees with this implementation, and everything after it is about our own
 * inputs.
 */

describe('against the published vectors', () => {
  // RFC 6238 appendix B uses the ASCII secret "12345678901234567890". Base32 of that
  // is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  test('decodes the secret to the bytes the RFC names', () => {
    expect(decodeBase32(SECRET)?.toString('ascii')).toBe('12345678901234567890');
  });

  test('produces the codes the RFC says, at the times it says', () => {
    // Each pair is (unix time, expected 8-digit code); the RFC lists eight digits and
    // ours are six, so the last six of each are what must match.
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];

    for (const [seconds, expected] of vectors) {
      const step = Math.floor(seconds / 30);
      expect(codeFor(SECRET, step)).toBe(expected.slice(-6));
    }
  });

  test('accepts the right code at the right time', () => {
    expect(verifyCode(SECRET, '287082', 59_000)).toBe(true);
  });
});

describe('checking a code', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);

  test('accepts the current one', () => {
    expect(verifyCode(secret, codeFor(secret, step) ?? '', now)).toBe(true);
  });

  test('allows one step either side, for a phone whose clock has drifted', () => {
    expect(verifyCode(secret, codeFor(secret, step - 1) ?? '', now)).toBe(true);
    expect(verifyCode(secret, codeFor(secret, step + 1) ?? '', now)).toBe(true);
  });

  test('refuses anything further out than that', () => {
    expect(verifyCode(secret, codeFor(secret, step - 5) ?? '', now)).toBe(false);
    expect(verifyCode(secret, codeFor(secret, step + 5) ?? '', now)).toBe(false);
  });

  test('refuses things that are not a code at all', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '000000x']) {
      expect(verifyCode(secret, bad, now)).toBe(false);
    }
  });

  test('ignores the spaces some apps put in', () => {
    const code = codeFor(secret, step) ?? '';
    expect(verifyCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });
});

describe('the secret', () => {
  test('is base32 an authenticator app will accept', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(secret)).not.toBeNull();
  });

  test('is different every time', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  test('tolerates however it was pasted back in', () => {
    // People paste these with spaces, dashes and padding, in any case.
    const canonical = decodeBase32('GEZDGNBVGY3TQOJQ');
    expect(decodeBase32('gezd gnbv gy3t qojq')).toEqual(canonical!);
    expect(decodeBase32('GEZD-GNBV-GY3T-QOJQ')).toEqual(canonical!);
    expect(decodeBase32('GEZDGNBVGY3TQOJQ====')).toEqual(canonical!);
  });

  test('refuses something that is not base32', () => {
    expect(decodeBase32('not base32!')).toBeNull();
    expect(decodeBase32('01890')).toBeNull();
  });
});

describe('what the QR code says', () => {
  test('is a scannable otpauth URL', () => {
    const url = new URL(otpauthUrl('ABC234', 'me@example.com'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe('ABC234');
    expect(url.searchParams.get('issuer')).toBe('Derailed');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(decodeURIComponent(url.pathname)).toContain('me@example.com');
  });
});

describe('recovery codes', () => {
  test('exist, because otherwise this is a way to lock yourself out for good', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });

  test('are all different', () => {
    expect(new Set(generateRecoveryCodes(20)).size).toBe(20);
  });
});
