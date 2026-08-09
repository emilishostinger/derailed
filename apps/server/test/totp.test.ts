import { describe, expect, test } from 'bun:test';
import {
  codeFor,
  decodeBase32,
  generateRecoveryCodes,
  generateSecret,
  otpauthUrl,
  verifyCode,
  verifyCodeStep,
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

/**
 * The step a code was good for, which is what makes a code single-use.
 *
 * The login flow remembers the last step somebody signed in with and refuses anything
 * at or before it. A boolean cannot express that, because a code and its neighbour a
 * few seconds later are both simply "yes"; the step tells them apart.
 */
describe('which step a code belongs to', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);

  test('names the step it matched, so a used one can be refused next time', () => {
    expect(verifyCodeStep(secret, codeFor(secret, step) ?? '', now)).toBe(step);
    expect(verifyCodeStep(secret, codeFor(secret, step - 1) ?? '', now)).toBe(step - 1);
    expect(verifyCodeStep(secret, codeFor(secret, step + 1) ?? '', now)).toBe(step + 1);
  });

  test('is null when the code is wrong, the same as a plain refusal', () => {
    expect(verifyCodeStep(secret, codeFor(secret, step - 5) ?? '', now)).toBeNull();
    expect(verifyCodeStep(secret, '000000x', now)).toBeNull();
  });

  test('a time near the epoch returns cleanly, not an uncaught range error', () => {
    // Found by fuzzing: at a time close to zero the drift window reaches step -1, and
    // the counter is an unsigned 64-bit field, so building a code for it threw a
    // RangeError that escaped the function. `Date.now()` never lands here, but a total
    // function returns null rather than throwing. `codeFor` for a negative step is null.
    expect(() => verifyCodeStep(secret, '000000', 0)).not.toThrow();
    expect(verifyCodeStep(secret, '000000', 0)).toBeNull();
    expect(codeFor(secret, -1)).toBeNull();
  });

  test('drives single use: the step the caller stored blocks a replay of that code', () => {
    // What the login handler does, in miniature: accept, remember the step, then refuse
    // any code whose step is not strictly newer, which is exactly a replay of the same
    // one (and its drift neighbours) inside the same window.
    const supplied = codeFor(secret, step) ?? '';
    const accepted = verifyCodeStep(secret, supplied, now);
    expect(accepted).toBe(step);

    let last = accepted;
    const replay = verifyCodeStep(secret, supplied, now + 5_000);
    expect(replay !== null && replay <= (last ?? -1)).toBe(true); // would be rejected

    // A genuinely later code, a step on, is greater than what was stored, so it passes.
    const nextStepCode = codeFor(secret, step + 1) ?? '';
    const next = verifyCodeStep(secret, nextStepCode, now + 30_000);
    expect(next !== null && next > (last ?? -1)).toBe(true);
    last = next;
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
