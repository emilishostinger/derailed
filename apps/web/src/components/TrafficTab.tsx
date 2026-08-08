import type { Service } from '@derailed/shared';
import { BarChart3, Bot, Clock, Gauge, TriangleAlert, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { cx, EmptyState, Spinner } from './ui.tsx';

export interface TrafficPoint {
  at: number;
  requests: number;
  visitors: number;
  errors: number;
  bots: number;
}

export interface TrafficReport {
  range: '24h' | '7d' | '30d';
  points: TrafficPoint[];
  totals: {
    requests: number;
    visitors: number;
    bots: number;
    bytes: number;
    avgMs: number;
    ok: number;
    redirects: number;
    clientErrors: number;
    serverErrors: number;
  };
  topPaths: { path: string; requests: number }[];
  topReferrers: { referrer: string; requests: number }[];
  slowestPaths: { path: string; requests: number; avgMs: number }[];
  live: number;
  previous: { requests: number; visitors: number; avgMs: number } | null;
  empty: boolean;
}

/**
 * How this compares with the window before.
 *
 * "Four hundred visitors" is a number. "Four hundred, up from two hundred and ten" is
 * the thing somebody actually wanted to know, and it is the difference between a page
 * you glance at and one you act on.
 *
 * Absent rather than zero when there is nothing to compare against: "up 100%" from a
 * standing start is noise dressed as news.
 */
function Change({
  now,
  before,
  lowerIsBetter,
}: {
  now: number;
  before?: number;
  lowerIsBetter?: boolean;
}) {
  if (before === undefined || before === 0) return null;
  const percent = Math.round(((now - before) / before) * 100);
  if (percent === 0) return <span className="text-[11px] text-ink-faint">same as before</span>;

  const up = percent > 0;
  const good = lowerIsBetter ? !up : up;
  return (
    <span className={cx('text-[11px]', good ? 'text-ok' : 'text-ink-faint')}>
      {up ? '+' : ''}
      {percent}% on the {before === 0 ? 'period' : 'window'} before
    </span>
  );
}

const RANGES = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const;

/**
 * Who is actually visiting.
 *
 * Counted by the proxy, which already sees every request, so there is no script in
 * anyone's pages and nothing about your visitors leaves this machine. It also means
 * the figures include people who block the usual analytics, which is most of the
 * reason the usual analytics disagree with reality.
 */
export function TrafficTab({ service }: { service: Service }) {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [report, setReport] = useState<TrafficReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = () =>
      endpoints
        .traffic(service.id, range)
        .then((data) => {
          if (alive) setReport(data);
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false);
        });

    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [service.id, range]);

  if (loading && !report) {
    return (
      <div className="flex justify-center py-16 text-ink-faint">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (report?.empty) {
    return (
      <EmptyState
        icon={<BarChart3 className="h-5 w-5" />}
        title="No visits yet"
        body="Once someone opens this app, its visits are counted here. Nothing is added to your pages: the figures come from the proxy that already serves every request."
      />
    );
  }

  const totals = report?.totals;

  return (
    <div className="space-y-6">
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

        {/* Right now, rather than over the window. The one figure on this page that
            answers "is anybody reading this" instead of "did anybody". */}
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
          note={<Change now={totals?.visitors ?? 0} before={report?.previous?.visitors} />}
        />
        <Stat
          icon={<BarChart3 className="h-3.5 w-3.5" />}
          label="Visits"
          value={compact(totals?.requests ?? 0)}
          note={<Change now={totals?.requests ?? 0} before={report?.previous?.requests} />}
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
          note={<Change now={totals?.avgMs ?? 0} before={report?.previous?.avgMs} lowerIsBetter />}
        />
      </div>

      {report && <Chart points={report.points} range={report.range} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <TopList
          title="Most read"
          rows={(report?.topPaths ?? []).map((row) => ({
            label: row.path,
            value: row.requests,
          }))}
          empty="Nothing yet."
          mono
        />
        <TopList
          title="Where people came from"
          rows={(report?.topReferrers ?? []).map((row) => ({
            label: row.referrer,
            value: row.requests,
          }))}
          empty="Everyone arrived directly."
        />
      </div>

      {/* Only pages asked for enough times to mean anything, which is why this can be
          empty on a quiet site while Most read is not. */}
      <TopList
        title="Slowest pages"
        rows={(report?.slowestPaths ?? []).map((row) => ({
          label: row.path,
          value: row.avgMs,
          suffix: 'ms',
        }))}
        empty="Nothing has been asked for often enough to have a reliable average yet."
        mono
      />

      <section>
        <p className="eyebrow mb-2">How it went</p>
        <div className="space-y-1.5">
          <Bar label="Served" value={totals?.ok ?? 0} total={totals?.requests ?? 0} tone="ok" />
          <Bar
            label="Sent somewhere else"
            value={totals?.redirects ?? 0}
            total={totals?.requests ?? 0}
            tone="muted"
          />
          <Bar
            label="Not found or refused"
            value={totals?.clientErrors ?? 0}
            total={totals?.requests ?? 0}
            tone="warn"
          />
          <Bar
            label="The app broke"
            value={totals?.serverErrors ?? 0}
            total={totals?.requests ?? 0}
            tone="danger"
          />
        </div>
        {(totals?.serverErrors ?? 0) > 0 && (
          <p className="mt-2.5 flex items-start gap-1.5 text-[12px] text-warn">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {totals?.serverErrors} request{totals?.serverErrors === 1 ? '' : 's'} failed inside the
            app. The Output tab usually says why.
          </p>
        )}
      </section>

      <p className="flex items-start gap-1.5 text-[12px] text-ink-faint">
        <Bot className="mt-0.5 h-3 w-3 shrink-0" />
        {compact(totals?.bots ?? 0)} more from crawlers and bots, kept out of the figures above.
        Visitors are counted from an address hashed with a key that never leaves this server, and
        forgotten after 45 days.
      </p>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold text-ink tabular">{value}</p>
      {note}
    </div>
  );
}

/**
 * A plain bar per bucket. Deliberately not a charting library: this is a hundred
 * rectangles, and a dependency for it would be bigger than the feature.
 */
function Chart({ points, range }: { points: TrafficPoint[]; range: string }) {
  const max = Math.max(1, ...points.map((point) => point.requests + (point.bots ?? 0)));

  return (
    <section>
      <p className="eyebrow mb-2">Visits</p>
      <div className="flex h-28 items-end gap-[2px] rounded-[var(--radius-card)] border border-line bg-surface-2 p-2.5">
        {points.map((point) => {
          const bots = point.bots ?? 0;
          const height = Math.round((point.requests / max) * 100);
          const botHeight = Math.round((bots / max) * 100);
          // Tinted only when a real share of the hour went wrong. A couple of 404s
          // among hundreds of visits is normal, and colouring the bar for it would
          // teach people to ignore the colour.
          const failed = point.requests > 0 && point.errors / point.requests >= 0.2;
          return (
            <div
              key={point.at}
              // Full height on the column, or a percentage on the bar inside it has
              // nothing to be a percentage of and every bar comes out flat. People
              // below in colour, bots stacked above in grey: the shape of the day
              // and the shape of the scraping, one glance apart.
              className="flex h-full flex-1 flex-col justify-end"
              title={`${label(point.at, range)}: ${point.requests} visit${point.requests === 1 ? '' : 's'}${
                point.visitors
                  ? `, ${point.visitors} visitor${point.visitors === 1 ? '' : 's'}`
                  : ''
              }${bots ? `, ${bots} from bots` : ''}${point.errors ? `, ${point.errors} failed` : ''}`}
            >
              {bots > 0 && (
                <div
                  className="w-full rounded-t-[2px] bg-ink-faint/40"
                  style={{ height: `${Math.max(botHeight, 2)}%` }}
                />
              )}
              <div
                className={cx(
                  'w-full rounded-[2px] transition-colors',
                  failed ? 'bg-warn/70' : 'bg-accent/70',
                  point.requests === 0 && bots === 0 && 'bg-line',
                )}
                style={{ height: `${Math.max(height, point.requests > 0 ? 4 : 2)}%` }}
              />
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Colour is people; grey on top is crawlers and bots.
      </p>
      <div className="mt-1 flex justify-between text-[11px] text-ink-faint tabular">
        <span>{points[0] ? label(points[0].at, range) : ''}</span>
        <span>{points.at(-1) ? label(points.at(-1)!.at, range) : ''}</span>
      </div>
    </section>
  );
}

function TopList({
  title,
  rows,
  empty,
  mono,
}: {
  title: string;
  rows: { label: string; value: number; suffix?: string }[];
  empty: string;
  mono?: boolean;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));

  return (
    <section>
      <p className="eyebrow mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.label} className="relative overflow-hidden rounded-[4px]">
              <div
                className="absolute inset-y-0 left-0 bg-accent-soft"
                style={{ width: `${(row.value / max) * 100}%` }}
              />
              <div className="relative flex items-center gap-2 px-2 py-1">
                <span className={cx('min-w-0 flex-1 truncate text-[12px] text-ink', mono && '')}>
                  {row.label}
                </span>
                <span className="shrink-0 text-[11px] text-ink-muted tabular">
                  {compact(row.value)}
                  {row.suffix ? ` ${row.suffix}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Bar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'ok' | 'muted' | 'warn' | 'danger';
}) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  const colour = {
    ok: 'bg-ok',
    muted: 'bg-ink-faint',
    warn: 'bg-warn',
    danger: 'bg-danger',
  }[tone];

  return (
    <div className="flex items-center gap-2.5">
      <span className="w-40 shrink-0 truncate text-[12px] text-ink-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className={cx('h-full rounded-full', colour)} style={{ width: `${percent}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] text-ink-muted tabular">
        {compact(value)}
      </span>
    </div>
  );
}

function label(at: number, range: string): string {
  const date = new Date(at);
  return range === '24h'
    ? date.toLocaleTimeString([], { hour: 'numeric' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
