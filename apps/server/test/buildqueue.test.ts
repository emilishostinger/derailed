import { describe, expect, test } from 'bun:test';
import { buildConcurrency } from '../src/build/pipeline.ts';

/**
 * How many builds run at once, and what the builder is allowed to reuse.
 *
 * Both are about the same server: the $5, one-or-two core box this is aimed at. A
 * build is the hungriest thing Derailed ever does, and the two settings that decide
 * whether a deploy finishes on a small machine are how many of them run together and
 * whether the second one has to start from nothing.
 */

describe('how many builds at once', () => {
  test('one on a single core, because two would fight over it', () => {
    // Not half as long each: longer than one after the other, because the time goes
    // on contention rather than on work. And on a small box, more likely to be killed
    // for running out of memory half way through.
    expect(buildConcurrency(1)).toBe(1);
  });

  test('still one on two cores, leaving one for everything else running', () => {
    // The machine is also serving the sites it is building. Handing both cores to the
    // builder makes every site on it slow while a deploy is in progress.
    expect(buildConcurrency(2)).toBe(1);
  });

  test('more as the machine gets bigger, up to a point', () => {
    expect(buildConcurrency(3)).toBe(2);
    expect(buildConcurrency(4)).toBe(3);
  });

  test('never more than three, however big the box', () => {
    // Past three the disk is the limit rather than the processor, and more builders
    // only means more of them waiting on it.
    expect(buildConcurrency(8)).toBe(3);
    expect(buildConcurrency(64)).toBe(3);
  });

  test('never zero, whatever the machine claims about itself', () => {
    // A container with no cpu information reports 0, and a queue with a limit of zero
    // is a queue that never moves.
    expect(buildConcurrency(0)).toBe(1);
    expect(buildConcurrency(-1)).toBe(1);
  });
});
