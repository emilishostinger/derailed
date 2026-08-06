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
const RANGES: { value: MetricsHistory['range']; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

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
          <Chart
            history={history}
            label="Processor"
            pick={(point) => point.cpuAverage}
            peak={(point) => point.cpuPeak}
            format={(value) => `${value.toFixed(1)}%`}
          />
          <Chart
            history={history}
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
  label,
  pick,
  peak,
  format,
}: {
  history: MetricsHistory;
  label: string;
  pick: (point: MetricsHistory['points'][number]) => number;
  peak: (point: MetricsHistory['points'][number]) => number;
  format: (value: number) => string;
}) {
  const points = history.points;
  const highest = Math.max(...points.map(peak), 1);
  const from = points[0]?.at ?? 0;
  const to = points[points.length - 1]?.at ?? 1;
  const span = Math.max(1, to - from);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="eyebrow">{label}</p>
        <p className="text-[12px] text-ink-faint">peak {format(highest)}</p>
      </div>

      <div className="relative h-24 rounded-[var(--radius-control)] bg-surface-2 p-1">
        <div className="flex h-full items-end gap-px">
          {points.map((point) => (
            <div
              key={point.at}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={`${new Date(point.at).toLocaleString()}\n${label}: ${format(pick(point))}, peak ${format(peak(point))}`}
            >
              <div
                className="absolute bottom-0 w-full rounded-t-[2px] bg-accent/25"
                style={{ height: `${(peak(point) / highest) * 100}%` }}
              />
              <div
                className="absolute bottom-0 w-full rounded-t-[2px] bg-accent"
                style={{ height: `${(pick(point) / highest) * 100}%` }}
              />
            </div>
          ))}
        </div>

        {/* The point of the whole screen. */}
        {history.deploys.map((deploy) => (
          <div
            key={deploy.id}
            className="absolute inset-y-1 w-px bg-ok"
            style={{ left: `${Math.min(99, Math.max(0, ((deploy.at - from) / span) * 100))}%` }}
            title={`Deployed ${new Date(deploy.at).toLocaleString()}${
              deploy.commitMessage ? `\n${deploy.commitMessage}` : ''
            }`}
          />
        ))}
      </div>

      {history.deploys.length > 0 && (
        <p className="mt-1 text-[12px] text-ink-faint">
          The green lines are deploys. {history.deploys.length} in this period.
        </p>
      )}
    </div>
  );
}
