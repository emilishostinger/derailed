/**
 * When a job should next run.
 *
 * The schedule is stored as a real cron expression, because that is the notation with
 * well-defined semantics and no ambiguity about what "every day" means at the end of
 * March. The plain-language choices in the dashboard compile down to one of a handful
 * of these, and "Advanced" lets somebody type their own.
 *
 * Only the five standard fields, and only what they actually mean: a star, a number,
 * a list, a range, and a step. No `@reboot`, no seconds, no names for months. Every one
 * of those is a thing to explain to somebody who did not want to learn cron.
 */

export interface CronParts {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const RANGES: [keyof CronParts, number, number][] = [
  ['minutes', 0, 59],
  ['hours', 0, 23],
  ['daysOfMonth', 1, 31],
  ['months', 1, 12],
  ['daysOfWeek', 0, 6],
];

export class CronError extends Error {}

// Expands one field: `*`, `5`, `1,3`, `1-5`, a step like `*` over 15, or `0-30/10`.
function expand(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [spec, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`"${part}" is not a valid step.`);

    let from = min;
    let to = max;
    if (spec !== '*' && spec !== undefined) {
      const [startText, endText] = spec.split('-');
      from = Number(startText);
      to = endText === undefined ? (stepText === undefined ? from : max) : Number(endText);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new CronError(`"${part}" is not a number or a range.`);
      }
      if (from < min || to > max || from > to) {
        throw new CronError(`"${part}" is outside ${min} to ${max}.`);
      }
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronParts {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError('A schedule has five parts: minute, hour, day, month, weekday.');
  }

  const parts = {} as CronParts;
  RANGES.forEach(([name, min, max], index) => {
    // Sunday is both 0 and 7 in every cron anyone has used, so accept the latter.
    const raw =
      name === 'daysOfWeek' ? (fields[index] ?? '').replace(/\b7\b/g, '0') : fields[index];
    parts[name] = expand(raw ?? '*', min, max);
  });
  return parts;
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * The next time this schedule matches, strictly after `from`.
 *
 * Walked minute by minute rather than solved, which sounds wasteful and is not: the
 * worst case is a schedule that only matches once a year, and even then this is a few
 * hundred thousand cheap comparisons done once when a job is saved.
 *
 * Day-of-month and day-of-week are ORed when both are restricted, which is what cron
 * does and surprises everybody exactly once.
 */
export function nextRun(expression: string, from: Date = new Date()): number | null {
  const parts = parseCron(expression);

  const dayRestricted = parts.daysOfMonth.length < 31;
  const weekdayRestricted = parts.daysOfWeek.length < 7;

  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  // Four years, so a 29 February schedule is still found rather than reported as
  // impossible.
  const limit = new Date(at.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);

  while (at < limit) {
    const monthOk = parts.months.includes(at.getMonth() + 1);
    const dayOk = parts.daysOfMonth.includes(at.getDate());
    const weekdayOk = parts.daysOfWeek.includes(at.getDay());

    const dateOk =
      monthOk &&
      (dayRestricted && weekdayRestricted
        ? dayOk || weekdayOk
        : dayRestricted
          ? dayOk
          : weekdayRestricted
            ? weekdayOk
            : true);

    if (dateOk && parts.hours.includes(at.getHours()) && parts.minutes.includes(at.getMinutes())) {
      return at.getTime();
    }

    at.setMinutes(at.getMinutes() + 1);
  }

  return null;
}

/**
 * The schedule in words, for the list.
 *
 * Only the shapes the dashboard itself produces are described exactly; anything typed
 * by hand falls through to showing the expression, which is what somebody who typed it
 * would recognise anyway.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const [minute, hour, dayOfMonth, month, weekday] = fields;

  const at = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (minute === '*' && hour === '*') return 'Every minute';
  if (hour === '*' && dayOfMonth === '*' && month === '*' && weekday === '*') {
    if (minute?.startsWith('*/')) return `Every ${minute.slice(2)} minutes`;
    return `Every hour, at ${minute} minutes past`;
  }
  if (dayOfMonth === '*' && month === '*' && weekday === '*' && minute && hour) {
    if (hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
    return `Every day at ${at(hour, minute)}`;
  }
  if (dayOfMonth === '*' && month === '*' && weekday && minute && hour && /^\d$/.test(weekday)) {
    return `Every ${days[Number(weekday)]} at ${at(hour, minute)}`;
  }
  if (
    month === '*' &&
    weekday === '*' &&
    dayOfMonth &&
    minute &&
    hour &&
    /^\d+$/.test(dayOfMonth)
  ) {
    return `On the ${dayOfMonth}${ordinal(Number(dayOfMonth))} of each month, at ${at(hour, minute)}`;
  }
  return expression;
}

function ordinal(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
}

/** The choices the dashboard offers, so nobody has to meet cron at all. */
export const PRESETS: { label: string; expression: (at: string, day: number) => string }[] = [
  { label: 'Every 15 minutes', expression: () => '*/15 * * * *' },
  { label: 'Every hour', expression: () => '0 * * * *' },
  {
    label: 'Every day',
    expression: (at) => {
      const [hour = '3', minute = '0'] = at.split(':');
      return `${Number(minute)} ${Number(hour)} * * *`;
    },
  },
  {
    label: 'Every week',
    expression: (at, day) => {
      const [hour = '3', minute = '0'] = at.split(':');
      return `${Number(minute)} ${Number(hour)} * * ${day}`;
    },
  },
];
