import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useSession } from '../stores/session.ts';
import { cx, Sparkline } from './ui.tsx';

type Stats = Awaited<ReturnType<typeof endpoints.serverStats>>;

/**
 * How the machine itself is doing, led by a sentence rather than a number. Someone
 * who doesn't know what a load average is should still know whether to worry.
 */
export function ServerStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const disk = useSession((s) => s.system?.disk);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await endpoints.serverStats().catch(() => null);
      if (!next || cancelled) return;
      setStats(next);
      setCpuHistory((history) => [...history, next.cpu.percent].slice(-40));
      setMemHistory((history) => [...history, next.memory.percent].slice(-40));
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!stats) return <p className="hint">Reading the server…</p>;

  const diskPercent = disk
    ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
    : null;

  return (
    <div className="space-y-4">
      <div
        className={cx(
          'flex items-center gap-2.5 rounded-[var(--radius-card)] border px-3.5 py-3',
          stats.level === 'ok'
            ? 'border-ok/25 bg-ok-soft'
            : stats.level === 'busy'
              ? 'border-line bg-surface-2'
              : 'border-warn/30 bg-warn-soft',
        )}
      >
        {stats.level === 'ok' ? (
          <CircleCheck className="h-4 w-4 shrink-0 text-ok" />
        ) : (
          <TriangleAlert
            className={cx(
              'h-4 w-4 shrink-0',
              stats.level === 'busy' ? 'text-ink-muted' : 'text-warn',
            )}
          />
        )}
        <p className="min-w-0 flex-1 text-[13px] text-ink">{stats.summary}</p>
        <span className="shrink-0 text-[12px] text-ink-faint tabular">
          up {formatUptime(stats.uptimeSeconds)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Processor"
          value={`${stats.cpu.percent}%`}
          detail={`${stats.cpu.cores} core${stats.cpu.cores === 1 ? '' : 's'}`}
          history={cpuHistory}
        />
        <StatTile
          label="Memory"
          value={`${stats.memory.percent}%`}
          detail={`${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}`}
          history={memHistory}
        />
        <StatTile
          label="Disk"
          value={disk ? formatBytes(disk.totalBytes - disk.freeBytes) : '-'}
          unit={disk ? `of ${formatBytes(disk.totalBytes)}` : undefined}
          detail={disk ? `${formatBytes(disk.freeBytes)} free` : 'Unknown'}
          percent={diskPercent ?? undefined}
        />
      </div>

      {stats.swap && stats.swap.usedBytes > 0 && (
        <p className="text-[12px] text-ink-faint">
          Using {formatBytes(stats.swap.usedBytes)} of swap. The server has run short of memory at
          some point.
        </p>
      )}
    </div>
  );
}

/**
 * One number, the way you would say it out loud, with its recent shape beside it.
 *
 * A current value and its trend is a stat tile, not a chart: there is no axis worth
 * drawing for "processor, 2%". The figure leads at display size and the sparkline is
 * context behind it, which is the opposite of the old arrangement, where the number
 * was a caption on the right of a progress bar.
 *
 * The value uses the font's proportional figures rather than tabular ones. Tabular
 * gives every digit the width of a zero, which reads loose at this size; nothing
 * moves when it changes because the sparkline is pinned to the other end of the row.
 */
function StatTile({
  label,
  value,
  unit,
  detail,
  history,
  percent,
}: {
  label: string;
  value: string;
  /** Said quietly after the value: "34 GB of 400 GB". */
  unit?: string;
  detail: string;
  history?: number[];
  /** Draws a meter instead of a sparkline, for a share of something finite. */
  percent?: number;
}) {
  // Severity, and only at the point where it is worth saying. The banner above
  // carries the words and the icon, so this is never the only thing saying it.
  const tone =
    percent === undefined
      ? 'text-accent'
      : percent > 90
        ? 'text-danger'
        : percent > 75
          ? 'text-warn'
          : 'text-accent';

  return (
    <div className="card p-4">
      <p className="text-[12px] text-ink-muted">{label}</p>

      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-[26px] leading-none font-semibold text-ink">
          {value}
          {unit && <span className="ml-1 text-[13px] font-normal text-ink-faint">{unit}</span>}
        </p>
        {history && (
          <Sparkline values={history} max={100} filled className={cx('h-9 w-24 shrink-0', tone)} />
        )}
      </div>

      {percent !== undefined && (
        <div
          className={cx(
            'mt-3 h-1.5 overflow-hidden rounded-full',
            // The empty part of the track is a lighter step of the fill's own colour,
            // so the whole bar reads as one measurement rather than a bar on a shelf.
            percent > 90 ? 'bg-danger-soft' : percent > 75 ? 'bg-warn-soft' : 'bg-accent-soft',
          )}
        >
          <div
            className={cx('h-full rounded-full bg-current transition-[width] duration-500', tone)}
            style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
          />
        </div>
      )}

      <p className="mt-2.5 text-[11px] text-ink-faint">{detail}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}
