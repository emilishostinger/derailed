/**
 * Keeping the limiter bounded without handing everyone a fresh start.
 *
 * The map cannot grow for ever, so at five thousand distinct keys it is trimmed. The old
 * line trimmed it with `this.hits.clear()`, which reset every counter at once: crossing
 * that line, on purpose, was a way to wipe a victim's window along with everyone's. The
 * trim now drops the entries that have already aged out, and then the oldest, so a key
 * that is actively being limited right now keeps its count.
 */
import { describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/http/auth.ts';

describe('trimming the limiter when it fills', () => {
  test('does not reset a key that is being limited right now', () => {
    const limiter = new RateLimiter(1, 60_000);

    // Nearly fill the map with old keys, then exhaust a victim added late, so the victim
    // is among the most recent entries rather than the oldest.
    for (let i = 0; i < 4999; i++) limiter.check(`old-${i}`);
    expect(limiter.check('victim')).toBe(true); // uses its single allowance
    expect(limiter.check('victim')).toBe(false); // now blocked

    // Cross the five-thousand threshold with fresh keys, which triggers the trim.
    for (let i = 0; i < 300; i++) limiter.check(`new-${i}`);

    // The victim was recent, not among the oldest dropped, so it is still blocked. Under
    // the old `clear()` the whole map was gone and this would be `true` again.
    expect(limiter.check('victim')).toBe(false);
  });

  test('stays bounded rather than growing without limit', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 12_000; i++) limiter.check(`k-${i}`);
    // Whatever the exact number, it is nowhere near twelve thousand.
    expect(limiter.size()).toBeLessThanOrEqual(5000);
  });
});
