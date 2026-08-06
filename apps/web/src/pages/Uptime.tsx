import type { Domain, UptimeSummary } from '@derailed/shared';
import { Activity, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, EmptyState, ErrorNote, Field, Spinner, Switch } from '../components/ui.tsx';
import { useToasts } from '../stores/toasts.ts';
import { PageHeader } from './Layout.tsx';

/**
 * Whether the sites are up.
 *
 * Derailed already knew whether a container was running, which is a different
 * question: a container can be running and serving five hundreds, and a certificate
 * can have expired underneath a perfectly healthy process. The only honest answer
 * comes from making the request a visitor would.
 */
interface Site {
  domain: Domain;
  service: string | null;
  uptime: UptimeSummary;
}

export function Uptime() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [page, setPage] = useState({ enabled: false, title: 'Status' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .uptime()
      .then((result) => {
        setSites(result.sites);
        setPage(result.statusPage);
      })
      .catch(() => setSites([]));
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <PageHeader title="Uptime" subtitle="Checked from this server every five minutes" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sites === null ? (
          <div className="p-5">
            <Spinner />
          </div>
        ) : sites.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-5 w-5" />}
            title="Nothing to watch yet"
            body="Once an app has a web address, Derailed checks it every five minutes and keeps ninety days of the answer."
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-3 p-5">
            <ErrorNote error={error} />

            {sites.map((site) => (
              <SiteRow
                key={site.domain.id}
                site={site}
                busy={busy === site.domain.id}
                onCheck={async () => {
                  setBusy(site.domain.id);
                  setError(null);
                  try {
                    await endpoints.checkUptime(site.domain.id);
                    load();
                  } catch (err) {
                    setError(err);
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            ))}

            <div className="card space-y-3 p-4">
              <p className="eyebrow">A page you can share</p>
              <Switch
                checked={page.enabled}
                label="Publish a status page"
                hint="Readable by anybody, with no sign-in. It shows the addresses, whether they are up, and ninety days of history. Nothing about your apps, your projects or this machine."
                onChange={async (next) => {
                  setBusy('page');
                  try {
                    setPage(await endpoints.setStatusPage({ ...page, enabled: next }));
                    push({ message: next ? 'Published.' : 'Taken down.', tone: 'ok' });
                  } catch (err) {
                    setError(err);
                  } finally {
                    setBusy(null);
                  }
                }}
              />

              {page.enabled && (
                <>
                  <div className="max-w-sm">
                    <Field label="What to call it">
                      <input
                        className="input"
                        value={page.title}
                        onChange={(event) => setPage({ ...page, title: event.target.value })}
                        onBlur={async () => {
                          try {
                            setPage(await endpoints.setStatusPage(page));
                          } catch (err) {
                            setError(err);
                          }
                        }}
                      />
                    </Field>
                  </div>
                  <a
                    className="link inline-flex items-center gap-1 text-[13px]"
                    href="/api/public/status.json"
                    target="_blank"
                    rel="noreferrer"
                  >
                    See what it says
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function SiteRow({ site, busy, onCheck }: { site: Site; busy: boolean; onCheck: () => void }) {
  const { uptime } = site;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            'h-2 w-2 shrink-0 rounded-full',
            uptime.up === null ? 'bg-ink-faint' : uptime.up ? 'bg-ok' : 'bg-danger',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-ink">{site.domain.hostname}</p>
          <p className="text-[12px] text-ink-faint">
            {uptime.up === null
              ? 'Not checked yet'
              : uptime.up
                ? `Up${uptime.uptimePercent !== null ? `, ${uptime.uptimePercent}% over 90 days` : ''}`
                : `Down: it ${uptime.lastReason ?? 'did not answer'}`}
            {site.service && ` · ${site.service}`}
          </p>
        </div>
        <button type="button" className="btn-ghost shrink-0" disabled={busy} onClick={onCheck}>
          {busy && <Spinner />}
          Check now
        </button>
      </div>

      {uptime.days.length > 0 && (
        <div className="mt-3 flex h-6 items-end gap-px">
          {uptime.days.map((day) => (
            <div
              key={day.day}
              className={cx(
                'h-full flex-1 rounded-[1px]',
                day.uptimePercent >= 100
                  ? 'bg-ok'
                  : day.uptimePercent >= 95
                    ? 'bg-warn'
                    : 'bg-danger',
              )}
              title={`${new Date(day.day).toLocaleDateString()}: ${day.uptimePercent}% up, ${day.averageMs} ms average`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
