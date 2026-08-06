import { describe, expect, test } from 'bun:test';
import { formatBytes } from '../src/system/disk.ts';
import { suggestedSwapBytes } from '../src/system/swap.ts';

/**
 * Disk, and the swap that stops a small server killing its own apps.
 *
 * The parts worth testing here are the ones that turn numbers into decisions: how big
 * a swap file to make, and how a size is written down. The rest of the report is a
 * reading of Docker's own figures and is covered by the route test.
 */

describe('how big a swap file to make', () => {
  const gb = 1024 ** 3;

  test('gives a small server twice its memory', () => {
    // The 1 GB VPS is the whole reason this exists: it has no headroom at all, and
    // what happens when it runs out is the kernel killing an app rather than a warning.
    expect(suggestedSwapBytes(1 * gb)).toBe(2 * gb);
    expect(suggestedSwapBytes(2 * gb)).toBe(4 * gb);
  });

  test('gives a mid-sized one the same again', () => {
    expect(suggestedSwapBytes(4 * gb)).toBe(4 * gb);
    expect(suggestedSwapBytes(8 * gb)).toBe(8 * gb);
  });

  test('stops at four gigabytes for anything larger', () => {
    // Past this the file costs more disk than the protection is worth, and a machine
    // this size that is swapping heavily has a different problem.
    expect(suggestedSwapBytes(16 * gb)).toBe(4 * gb);
    expect(suggestedSwapBytes(64 * gb)).toBe(4 * gb);
  });
});

describe('writing sizes down', () => {
  test('uses the unit a person would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  test('drops the decimal once the number is big enough not to need it', () => {
    // "12.4 GB" reads as a measurement; "12 GB" reads as an amount, which is what
    // someone deciding whether to tidy up actually wants.
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
    expect(formatBytes(999 * 1024 ** 2)).toBe('999 MB');
  });

  test('does not run out of units', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(formatBytes(9000 * 1024 ** 4)).toContain('TB');
  });

  test('handles nothing at all', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
});
