/**
 * The QR encoder, checked structurally.
 *
 * The QR code is drawn on the box, not fetched from an online generator, precisely so
 * a server with no outbound internet still shows one and no third party learns every
 * address on the machine. That independence is only worth having if the code it draws
 * actually scans, and a QR that is subtly wrong scans as nothing or, worse, as the
 * wrong URL. There is no decoder in the test suite, so this asserts the structure every
 * valid QR must have: a square matrix, the three finder patterns in their corners, a
 * quiet margin, determinism, and an SVG whose viewBox matches the matrix it drew.
 */
import { describe, expect, test } from 'bun:test';
import { encodeQr, qrSvg } from '../src/lib/qr.ts';

/** The 7x7 finder pattern: a dark ring, a light ring, a 3x3 dark centre. */
function isFinderPattern(m: boolean[][], top: number, left: number): boolean {
  const expected = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const want = expected[r]![c] === '1';
      if ((m[top + r]?.[left + c] ?? false) !== want) return false;
    }
  }
  return true;
}

describe('the QR matrix', () => {
  test('is a non-trivial square', () => {
    const m = encodeQr('https://shop-web.203-0-113-7.sslip.io');
    expect(m.length).toBeGreaterThanOrEqual(21); // version 1 is 21x21, the smallest
    for (const row of m) expect(row.length).toBe(m.length);
  });

  test('carries the three finder patterns, in the three corners a scanner looks', () => {
    const m = encodeQr('https://example.com/some/path');
    const n = m.length;
    // Top-left, top-right, bottom-left. (A QR has no finder in the bottom-right.)
    expect(isFinderPattern(m, 0, 0)).toBe(true);
    expect(isFinderPattern(m, 0, n - 7)).toBe(true);
    expect(isFinderPattern(m, n - 7, 0)).toBe(true);
  });

  test('is deterministic: the same text draws the same code every time', () => {
    const a = encodeQr('deterministic please');
    const b = encodeQr('deterministic please');
    expect(a).toEqual(b);
  });

  test('two different texts draw different codes', () => {
    const a = JSON.stringify(encodeQr('one'));
    const b = JSON.stringify(encodeQr('two'));
    expect(a).not.toBe(b);
  });

  test('grows to a larger version when the text no longer fits the smallest', () => {
    const small = encodeQr('hi').length;
    // Longer than the smallest version holds, but still within what the encoder draws.
    const big = encodeQr('https://a-fairly-long-preview.203-0-113-7.sslip.io/path').length;
    expect(big).toBeGreaterThan(small);
  });
});

describe('the QR as an SVG', () => {
  test('is well-formed and sized to the matrix, with the quiet margin included', () => {
    const text = 'https://example.com';
    const matrix = encodeQr(text);
    const margin = 3;
    const svg = qrSvg(text, { size: 200, margin });

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // The drawing coordinate space is the matrix plus a quiet zone on each side.
    expect(svg).toContain(
      `viewBox="0 0 ${matrix.length + margin * 2} ${matrix.length + margin * 2}"`,
    );
  });

  test('draws at least one dark module (it is not a blank square)', () => {
    const svg = qrSvg('anything', { size: 120, margin: 2 });
    // The dark modules are drawn as rects or a path; either way there is fill geometry.
    expect(/<(rect|path)/.test(svg)).toBe(true);
  });
});
