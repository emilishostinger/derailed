import { CircleCheck, Cpu, HardDrive, MemoryStick, TriangleAlert } from 'lucide-react';
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
        <Meter
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Processor"
          percent={stats.cpu.percent}
          detail={`${stats.cpu.cores} core${stats.cpu.cores === 1 ? '' : 's'}`}
          history={cpuHistory}
        />
        <Meter
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="Memory"
          percent={stats.memory.percent}
          detail={`${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}`}
          history={memHistory}
        />
        <Meter
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="Disk"
          percent={diskPercent ?? 0}
          detail={disk ? `${formatBytes(disk.freeBytes)} free` : 'Unknown'}
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

function Meter({
  icon,
  label,
  percent,
  detail,
  history,
}: {
  icon: React.ReactNode;
  label: string;
  percent: number;
  detail: string;
  history?: number[];
}) {
  const tone = percent > 90 ? 'bg-danger' : percent > 75 ? 'bg-warn' : 'bg-ok';
  const toneText = percent > 90 ? 'text-danger' : percent > 75 ? 'text-warn' : 'text-ok';

  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        <span className="text-ink-faint">{icon}</span>
        {label}
        <span className="ml-auto text-[13px] font-medium text-ink tabular">{percent}%</span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cx('h-full rounded-full transition-[width] duration-500', tone)}
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>

      {history && (
        <Sparkline
          values={history}
          max={100}
          filled
          className={cx('mt-2.5 h-8 w-full', toneText)}
        />
      )}

      <p className="mt-1.5 text-[11px] text-ink-faint tabular">{detail}</p>
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
