import type { MetricsHistory, Service } from '@derailed/shared';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { cx, Spinner } from './ui.tsx';

/**
 * What this app has been doing, an hour at a time.
 *
 * The chart is not the feature. The vertical lines on it are: "memory started
 * climbing on Tuesday" is an observation, "memory started climbing right after that
 * deploy" is a diagnosis, and the only difference is knowing when the deploys were.
 */
const HOUR = 60 * 60 * 1000;

/**
 * How long a window is, and how finely to slice it.
 *
 * The slice matters as much as the span. Figures are recorded hourly, and drawing
 * seven hundred hourly bars across a month gives sub-pixel columns; drawing them as
 * equal-width bars regardless of the window, which is what this used to do, gives
 * three ranges that look identical because ten readings fill the width whichever
 * button you pressed. That reads as a broken control rather than as a short history.
 */
const RANGES: {
  value: MetricsHistory['range'];
  label: string;
  span: number;
  bucket: number;
}[] = [
  { value: '24h', label: '24 hours', span: 24 * HOUR, bucket: HOUR },
  { value: '7d', label: '7 days', span: 7 * 24 * HOUR, bucket: 6 * HOUR },
  { value: '30d', label: '30 days', span: 30 * 24 * HOUR, bucket: 24 * HOUR },
];

function rangeOf(value: MetricsHistory['range']) {
  return RANGES.find((entry) => entry.value === value) ?? RANGES[0]!;
}

/** "9 hours", "3 days". For saying plainly how much there actually is. */
function describeSpan(ms: number): string {
  const hours = Math.round(ms / HOUR);
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

export function MetricsTab({ service }: { service: Service }) {
  const [range, setRange] = useState<MetricsHistory['range']>('24h');
  const [history, setHistory] = useState<MetricsHistory | null>(null);

  useEffect(() => {
    setHistory(null);
    endpoints
      .metrics(service.id, range)
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [service.id, range]);

  const points = history?.points ?? [];
  const covered = points.length
    ? (points[points.length - 1]?.at ?? 0) - (points[0]?.at ?? 0) + HOUR
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        {RANGES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className={cx(
              'rounded-[var(--radius-control)] border px-2.5 py-1 text-[12px]',
              range === entry.value
                ? 'border-accent bg-accent/10 text-ink'
                : 'border-line text-ink-muted',
            )}
            onClick={() => setRange(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {!history ? (
        <Spinner />
      ) : history.points.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          Nothing recorded yet. Figures are kept from the moment the app is running, an hour at a
          time.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-ink">{history.summary}</p>

          {/* Said out loud, because the alternative is somebody pressing 30 days,
              seeing a chart that is mostly empty, and concluding the button is
              broken rather than that the server has only been watched for an
              afternoon. */}
          {covered < rangeOf(range).span * 0.9 && (
            <p className="text-[12px] text-ink-faint">
              There is only {describeSpan(covered)} of history so far, so most of this window is
              empty. It fills in as the app keeps running.
            </p>
          )}

          <Chart
            history={history}
            range={range}
            label="Processor"
            pick={(point) => point.cpuAverage}
            peak={(point) => point.cpuPeak}
            format={(value) => `${value.toFixed(1)}%`}
          />
          <Chart
            history={history}
            range={range}
            label="Memory"
            pick={(point) => point.memoryAverage}
            peak={(point) => point.memoryPeak}
            format={(value) => formatBytes(value)}
          />
        </>
      )}
    </div>
  );
}

/**
 * A bar per hour, with the peak drawn behind the average.
 *
 * Hand-drawn rather than a charting library: two dozen bars and some vertical lines
 * is not worth two hundred kilobytes in a binary people are asked to trust, and the
 * result reads better at this size than a general-purpose chart would.
 */
function Chart({
  history,
  range,
  label,
  pick,
  peak,
  format,
}: {
  history: MetricsHistory;
  range: MetricsHistory['range'];
  label: string;
  pick: (point: MetricsHistory['points'][number]) => number;
  peak: (point: MetricsHistory['points'][number]) => number;
  format: (value: number) => string;
}) {
  const { span, bucket } = rangeOf(range);

  // The window is the one that was asked for, ending now, rather than whatever
  // happens to be in the data. That is the entire fix for three ranges that drew
  // the same picture: the axis now means something, so a short history looks short.
  const to = Date.now();
  const from = to - span;
  const slots = Math.round(span / bucket);

  // Hourly readings folded into whatever slice this range uses. Average of the
  // averages, peak of the peaks: a peak that got averaged away is a peak nobody
  // will ever be told about, and peaks are what this chart is read for.
  const buckets = Array.from({ length: slots }, (_unused, index) => ({
    at: from + index * bucket,
    left: (index / slots) * 100,
    total: 0,
    n: 0,
    peak: 0,
  }));
  for (const point of history.points) {
    const index = Math.floor((point.at - from) / bucket);
    if (index < 0 || index >= slots) continue;
    const slot = buckets[index]!;
    slot.total += pick(point);
    slot.n += 1;
    slot.peak = Math.max(slot.peak, peak(point));
  }

  const highest = Math.max(...buckets.map((slot) => slot.peak), 1);
  const at = (moment: number) => ((moment - from) / span) * 100;

  const axis = (moment: number) =>
    span > 48 * HOUR
      ? new Date(moment).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : new Date(moment).toLocaleTimeString(undefined, { hour: 'numeric' });

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="eyebrow">{label}</p>
        <p className="text-[12px] text-ink-faint">peak {format(highest)}</p>
      </div>

      <div className="relative h-24 rounded-[var(--radius-control)] bg-surface-2 p-1">
        <div className="relative h-full">
          {buckets.map((slot) =>
            slot.n === 0 ? null : (
              <div
                key={slot.at}
                className="absolute bottom-0"
                style={{
                  left: `${slot.left}%`,
                  // Never thinner than a pixel, or a day in a month-wide window is
                  // drawn as nothing at all.
                  width: `max(1px, ${(1 / slots) * 100}%)`,
                }}
                title={`${new Date(slot.at).toLocaleString()}\n${label}: ${format(
                  slot.total / slot.n,
                )}, peak ${format(slot.peak)}`}
              >
                <div
                  className="absolute bottom-0 w-full rounded-t-[2px] bg-accent/25"
                  style={{ height: `${(slot.peak / highest) * 96}px` }}
                />
                <div
                  className="absolute bottom-0 w-full rounded-t-[2px] bg-accent"
                  style={{ height: `${(slot.total / slot.n / highest) * 96}px` }}
                />
              </div>
            ),
          )}
        </div>

        {/* The point of the whole screen. */}
        {history.deploys
          .filter((deploy) => deploy.at >= from && deploy.at <= to)
          .map((deploy) => (
            <div
              key={deploy.id}
              className="absolute inset-y-1 w-px bg-ok"
              style={{ left: `${Math.min(99.8, Math.max(0, at(deploy.at)))}%` }}
              title={`Deployed ${new Date(deploy.at).toLocaleString()}${
                deploy.commitMessage ? `\n${deploy.commitMessage}` : ''
              }`}
            />
          ))}
      </div>

      {/* Both ends labelled, so the window is readable rather than implied. */}
      <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
        <span>{axis(from)}</span>
        <span>now</span>
      </div>

      {history.deploys.length > 0 && (
        <p className="mt-0.5 text-[12px] text-ink-faint">
          The green lines are deploys. {history.deploys.length} in this period.
        </p>
      )}
    </div>
  );
}
