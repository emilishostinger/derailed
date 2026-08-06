import { describe, expect, test } from 'bun:test';
import { CronError, describeCron, isValidCron, nextRun, parseCron } from '../src/jobs/schedule.ts';

/**
 * Working out when a job runs next.
 *
 * Cron is full of edge cases that surprise people exactly once, and getting one wrong
 * means a nightly backup that quietly runs twice, or never. So the tests are mostly
 * about the awkward corners: the day-of-month and weekday rule, the end of a month,
 * the end of a year, and refusing nonsense rather than accepting it and doing
 * something arbitrary.
 */

describe('reading a schedule', () => {
  test('understands the plain shapes', () => {
    expect(parseCron('0 3 * * *').hours).toEqual([3]);
    expect(parseCron('0 3 * * *').minutes).toEqual([0]);
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9-17 * * *').hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parseCron('0,30 * * * *').minutes).toEqual([0, 30]);
    expect(parseCron('0 0-12/6 * * *').hours).toEqual([0, 6, 12]);
  });

  test('treats Sunday as both 0 and 7, because every cron does', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 0').daysOfWeek).toEqual([0]);
  });

  test('refuses nonsense rather than doing something arbitrary with it', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      'every day',
      '*/0 * * * *',
      '5-1 * * * *',
    ]) {
      expect(isValidCron(bad)).toBe(false);
      expect(() => parseCron(bad)).toThrow(CronError);
    }
  });
});

describe('when it next runs', () => {
  const on = (iso: string) => new Date(iso);
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString().slice(0, 16));

  test('finds the next daily run later the same day', () => {
    expect(iso(nextRun('0 15 * * *', on('2026-03-10T09:00:00')))).toBe('2026-03-10T15:00');
  });

  test('rolls to tomorrow once today has passed', () => {
    expect(iso(nextRun('0 3 * * *', on('2026-03-10T09:00:00')))).toBe('2026-03-11T03:00');
  });

  test('is strictly later, so a job does not run twice in the same minute', () => {
    // Called again the instant a run finishes, this must not return the same minute.
    expect(iso(nextRun('0 3 * * *', on('2026-03-10T03:00:00')))).toBe('2026-03-11T03:00');
  });

  test('crosses the end of a month', () => {
    expect(iso(nextRun('0 3 * * *', on('2026-03-31T09:00:00')))).toBe('2026-04-01T03:00');
  });

  test('crosses the end of a year', () => {
    expect(iso(nextRun('30 2 * * *', on('2026-12-31T23:00:00')))).toBe('2027-01-01T02:30');
  });

  test('finds a date that only exists in leap years', () => {
    // Four years of searching rather than one, or this would be reported impossible.
    expect(iso(nextRun('0 0 29 2 *', on('2026-06-01T00:00:00')))).toBe('2028-02-29T00:00');
  });

  test('handles a weekday schedule', () => {
    // 2026-03-10 is a Tuesday, so the next Monday is the 16th.
    expect(iso(nextRun('0 9 * * 1', on('2026-03-10T09:00:00')))).toBe('2026-03-16T09:00');
  });

  test('ORs day-of-month with weekday, which is what cron does', () => {
    // "the 1st, or any Friday". 2026-03-10 is a Tuesday; Friday the 13th comes first.
    expect(iso(nextRun('0 0 1 * 5', on('2026-03-10T00:00:00')))).toBe('2026-03-13T00:00');
  });

  test('ANDs neither when both are unrestricted', () => {
    expect(iso(nextRun('0 0 * * *', on('2026-03-10T12:00:00')))).toBe('2026-03-11T00:00');
  });
});

describe('saying it in words', () => {
  test('describes the shapes the dashboard itself produces', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 * * * *')).toBe('Every hour, at 0 minutes past');
    expect(describeCron('0 3 * * *')).toBe('Every day at 03:00');
    expect(describeCron('30 2 * * 1')).toBe('Every Monday at 02:30');
    expect(describeCron('0 4 1 * *')).toContain('1st of each month');
  });

  test('falls back to the expression for anything typed by hand', () => {
    // Somebody who wrote this recognises it; inventing a sentence for it would be
    // more likely to be wrong than useful.
    expect(describeCron('5 4 */2 * 3')).toBe('5 4 */2 * 3');
  });

  test('does not choke on something that is not a schedule at all', () => {
    expect(describeCron('nonsense')).toBe('nonsense');
  });
});
