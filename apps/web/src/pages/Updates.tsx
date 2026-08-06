import {
  CircleCheck,
  Container,
  Download,
  Package,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, ErrorNote, Spinner } from '../components/ui.tsx';
import { PageHeader } from './Layout.tsx';

export interface UpdateItem {
  id: string;
  kind: 'system' | 'image' | 'derailed';
  name: string;
  detail: string;
  security?: boolean;
  current?: string | null;
  available?: string | null;
  actionable: boolean;
}

export interface UpdateReport {
  checkedAt: number;
  items: UpdateItem[];
  rebootRequired: boolean;
  rebootReason: string | null;
  summary: string;
  cached: boolean;
}

/**
 * What is out of date on this machine, and a button to fix it.
 *
 * Deliberately never updates anything on its own. Someone's website going down
 * because a package upgraded itself at 3am is exactly the kind of surprise this
 * product exists to avoid.
 */
export function Updates() {
  const [report, setReport] = useState<UpdateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function check(force = false) {
    setChecking(true);
    setError(null);
    try {
      setReport(await endpoints.updates(force));
    } catch (err) {
      setError(err);
    } finally {
      setChecking(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: checked once on arrival; `check` is recreated every render.
  useEffect(() => {
    void check();
  }, []);

  async function apply(item: UpdateItem) {
    setWorking(item.id);
    setError(null);
    setDone(null);
    try {
      const result = await endpoints.applyUpdate(item.id);
      setDone(result.message);
      await check(true);
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  const clean = report && report.items.length === 0 && !report.rebootRequired;

  return (
    <>
      <PageHeader
        title="Updates"
        subtitle={report ? new Date(report.checkedAt).toLocaleTimeString() : undefined}
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={checking}
            onClick={() => void check(true)}
          >
            {checking ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check again
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 p-5">
          {!report && checking && <p className="hint">Looking for updates…</p>}

          {report && (
            <div
              className={cx(
                'flex items-center gap-2.5 rounded-[var(--radius-card)] border px-3.5 py-3',
                clean
                  ? 'border-ok/25 bg-ok-soft'
                  : report.items.some((item) => item.security)
                    ? 'border-warn/30 bg-warn-soft'
                    : 'border-line bg-surface-2',
              )}
            >
              {clean ? (
                <CircleCheck className="h-4 w-4 shrink-0 text-ok" />
              ) : (
                <TriangleAlert className="h-4 w-4 shrink-0 text-warn" />
              )}
              <p className="min-w-0 flex-1 text-[13px] text-ink">{report.summary}</p>
            </div>
          )}

          {done && (
            <div className="rounded-[var(--radius-card)] border border-ok/25 bg-ok-soft px-3.5 py-3 text-[13px] text-ink">
              {done}
            </div>
          )}
          <ErrorNote error={error} />

          {report?.rebootRequired && (
            <div className="card p-4">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <RotateCw className="h-4 w-4 text-warn" />
                This server needs restarting
              </p>
              <p className="mt-1.5 text-[12px] text-ink-muted">
                {report.rebootReason ?? 'Some updates only take effect after a restart.'} Your apps
                come back by themselves afterwards, but the server is offline for about a minute.
              </p>
              <p className="mt-2 text-[11px] text-ink-faint">
                Run <span className="text-ink">reboot</span> on the server when it suits you.
              </p>
            </div>
          )}

          {report && report.items.length > 0 && (
            <div className="space-y-2">
              {report.items.map((item) => (
                <div key={item.id} className="card p-4">
                  <div className="flex items-start gap-2.5">
                    <KindIcon kind={item.kind} security={item.security} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink">{item.name}</p>
                      <p className="mt-1 text-[12px] text-ink-muted">{item.detail}</p>
                      {item.current && item.available && (
                        <p className="mt-1.5 text-[11px] text-ink-faint">
                          {item.current} to {item.available}
                        </p>
                      )}
                    </div>
                    {item.actionable && (
                      <button
                        type="button"
                        className="btn-primary shrink-0"
                        disabled={working !== null}
                        onClick={() => void apply(item)}
                      >
                        {working === item.id ? <Spinner /> : <Download className="h-3.5 w-3.5" />}
                        Update
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[12px] text-ink-faint">
            Derailed never updates anything by itself. A website going down because something
            upgraded overnight is exactly the surprise this is meant to avoid.
          </p>
        </div>
      </div>
    </>
  );
}

function KindIcon({ kind, security }: { kind: UpdateItem['kind']; security?: boolean }) {
  const Icon = kind === 'image' ? Container : kind === 'derailed' ? Download : Package;
  return (
    <span
      className={cx(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] border',
        security
          ? 'border-warn/40 bg-warn-soft text-warn'
          : 'border-line bg-surface-2 text-ink-faint',
      )}
    >
      {security ? <ShieldAlert className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
    </span>
  );
}
