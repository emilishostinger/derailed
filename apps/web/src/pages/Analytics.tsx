import { BarChart3, Clock, Gauge, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { type ScopeOption, ScopePicker } from '../components/ScopePicker.tsx';
import { cx } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
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
  const projects = useProjects((s) => s.projects);
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  /**
   * What is being looked at: the whole machine, one project, or one app.
   *
   * Held as a single string with a prefix rather than two pieces of state, because
   * the three are one choice and two booleans would let them disagree.
   */
  const [scope, setScope] = useState<string>('');
  const [report, setReport] = useState<Report | null>(null);

  /** Only projects with something in them: an empty one has nothing to show. */
  const withApps = useMemo(
    () =>
      projects.filter((project) =>
        (project.services ?? []).some((service) => service.kind === 'app'),
      ),
    [projects],
  );

  /** Everything, grouped: the whole server, then each project, then its apps. */
  const options = useMemo<ScopeOption[]>(() => {
    const counted = new Map<string, number>();
    for (const project of projects) {
      for (const service of project.services ?? []) {
        if (service.kind === 'app') counted.set(service.name, (counted.get(service.name) ?? 0) + 1);
      }
    }

    return [
      { value: '', label: 'The whole server' },
      ...withApps.flatMap((project) => [
        {
          value: `project:${project.id}`,
          label: project.name,
          group: project.name,
          meta: 'whole project',
        },
        ...(project.services ?? [])
          .filter((service) => service.kind === 'app')
          .map((service) => ({
            value: `service:${service.id}`,
            label: (counted.get(service.name) ?? 0) > 1 ? service.slug : service.name,
            group: project.name,
          })),
      ]),
    ];
  }, [projects, withApps]);

  // Something deleted while this tab was open falls back to the whole server rather
  // than asking for figures nobody can produce.
  useEffect(() => {
    if (scope && !options.some((option) => option.value === scope)) setScope('');
  }, [scope, options]);

  useEffect(() => {
    setReport(null);
    const [kind, id] = scope.split(':');
    endpoints
      .serverTraffic(
        range,
        kind === 'project' ? { project: id } : kind === 'service' ? { service: id } : undefined,
      )
      .then(setReport)
      .catch(() => setReport(null));
  }, [range, scope]);

  /**
   * Where each app lives, and what to call it.
   *
   * The server sends the app's own name, and three of them here are called
   * `index.html`. Three identical rows in a list of figures is three rows nobody can
   * act on, so a duplicated name falls back to the slug, which is unique per project.
   */
  const appInfo = useMemo(() => {
    const counted = new Map<string, number>();
    for (const project of projects) {
      for (const service of project.services ?? []) {
        if (service.kind === 'app') counted.set(service.name, (counted.get(service.name) ?? 0) + 1);
      }
    }

    const map = new Map<string, { project: string; label: string }>();
    for (const project of projects) {
      for (const service of project.services ?? []) {
        map.set(service.id, {
          project: project.slug,
          label: (counted.get(service.name) ?? 0) > 1 ? service.slug : service.name,
        });
      }
    }
    return map;
  }, [projects]);

  const totals = report?.totals;
  const busiest = Math.max(1, ...(report?.byService ?? []).map((row) => row.requests));

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={
          scope
            ? `${options.find((option) => option.value === scope)?.label ?? 'One app'}, on its own`
            : 'Every app on this server, added up'
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {options.length > 2 && (
              <ScopePicker label="Showing" value={scope} options={options} onChange={setScope} />
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {RANGES.map(([value, label]) => (
                <Chip
                  key={value}
                  label={label}
                  active={range === value}
                  onSelect={() => setRange(value)}
                />
              ))}
            </div>
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
                {report?.byService.map((row) => {
                  // Straight into that app's own Visitors tab, which already has the
                  // detail one app deserves: its chart over time, its slowest pages,
                  // and how the week compares. A lesser copy of that here would be two
                  // screens answering one question differently.
                  const app = appInfo.get(row.serviceId);
                  const home = app?.project;
                  const inner = (
                    <>
                      <div
                        className="absolute inset-y-0 left-0 bg-accent-soft"
                        style={{ width: `${(row.requests / busiest) * 100}%` }}
                      />
                      <div className="relative flex items-center gap-2 px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                          {app?.label ?? row.name}
                        </span>
                        <span className="shrink-0 text-[12px] text-ink-muted tabular">
                          {compact(row.visitors)} visitors
                        </span>
                        <span className="w-20 shrink-0 text-right text-[12px] text-ink-muted tabular">
                          {compact(row.requests)} visits
                        </span>
                      </div>
                    </>
                  );

                  return home ? (
                    <Link
                      key={row.serviceId}
                      to={`/p/${home}?service=${row.serviceId}&tab=traffic`}
                      className="relative block overflow-hidden rounded-[4px] hover:bg-surface-2"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={row.serviceId} className="relative overflow-hidden rounded-[4px]">
                      {inner}
                    </div>
                  );
                })}
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

/** One filter button, the same one the Logs page draws. */
function Chip({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(
        'btn border text-[12px]',
        active
          ? 'border-accent bg-accent-soft text-ink'
          : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink',
      )}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}
