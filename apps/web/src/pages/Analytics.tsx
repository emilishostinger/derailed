import { BarChart3, Clock, Gauge, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx } from '../components/ui.tsx';
import { formatBytes, PageHeader } from './Layout.tsx';

type Report = Awaited<ReturnType<typeof endpoints.serverTraffic>>;

const RANGES = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const;

/**
 * Every app's traffic, added up.
 *
 * "Is this machine busy" is a different question from "how is this app doing", and
 * answering it meant opening each app's Visitors tab in turn and adding up by eye.
 *
 * Counted by the proxy, which already sees every request, so there is no script in
 * anybody's pages and nothing about your visitors leaves this machine.
 */
export function Analytics() {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    endpoints
      .serverTraffic(range)
      .then(setReport)
      .catch(() => setReport(null));
  }, [range]);

  const totals = report?.totals;
  const busiest = Math.max(1, ...(report?.byService ?? []).map((row) => row.requests));

  return (
    <>
      <PageHeader title="Visitors" subtitle="Every app on this server, added up" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cx(
                  'btn border text-[12px]',
                  range === value
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink',
                )}
                onClick={() => setRange(value)}
              >
                {label}
              </button>
            ))}
            {(report?.live ?? 0) > 0 && (
              <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                {report?.live} here now
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat
              icon={<Users className="h-3.5 w-3.5" />}
              label="Visitors"
              value={compact(totals?.visitors ?? 0)}
            />
            <Stat
              icon={<BarChart3 className="h-3.5 w-3.5" />}
              label="Visits"
              value={compact(totals?.requests ?? 0)}
            />
            <Stat
              icon={<Gauge className="h-3.5 w-3.5" />}
              label="Data sent"
              value={formatBytes(totals?.bytes ?? 0)}
            />
            <Stat
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Typical reply"
              value={`${totals?.avgMs ?? 0} ms`}
            />
          </div>

          {/* Said here rather than only in the documentation, because a number that is
              an upper bound and does not say so is a number people quote. */}
          <p className="text-[12px] text-ink-faint">
            Visitors are counted once per app. A visitor is identified by a code that includes the
            app's own id, so the same person reading two of your sites cannot be recognised as one,
            which is the point: nothing here can follow somebody across your sites.
          </p>

          <section>
            <p className="eyebrow mb-2">By app</p>
            {(report?.byService.length ?? 0) === 0 ? (
              <p className="hint">Nothing has been visited yet.</p>
            ) : (
              <div className="space-y-1">
                {report?.byService.map((row) => (
                  <div key={row.serviceId} className="relative overflow-hidden rounded-[4px]">
                    <div
                      className="absolute inset-y-0 left-0 bg-accent-soft"
                      style={{ width: `${(row.requests / busiest) * 100}%` }}
                    />
                    <div className="relative flex items-center gap-2 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {row.name}
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-muted tabular">
                        {compact(row.visitors)} visitors
                      </span>
                      <span className="w-20 shrink-0 text-right text-[12px] text-ink-muted tabular">
                        {compact(row.requests)} visits
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {(totals?.bots ?? 0) > 0 && (
            <p className="text-[12px] text-ink-faint">
              {compact(totals?.bots ?? 0)} requests came from crawlers and are left out of the
              figures above.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold text-ink tabular">{value}</p>
    </div>
  );
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
