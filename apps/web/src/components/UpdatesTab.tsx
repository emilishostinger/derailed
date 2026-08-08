import type { AppUpdate, Service } from '@derailed/shared';
import { ArrowUpCircle, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner, Switch } from './ui.tsx';

type State = Awaited<ReturnType<typeof endpoints.appUpdateState>>;

/**
 * Updating, as three promises kept in order: a copy first, a check before the new
 * version takes over, and one press to put it back. The screen leads with the
 * promises rather than the digests, because the digests are not the point.
 */
export function UpdatesTab({ service }: { service: Service }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints.appUpdateState(service.id).then(setState).catch(setError);
  }, [service.id]);

  useEffect(load, [load]);

  // The update runs for minutes and reports over the socket; the row arriving is
  // the reload signal, so the screen follows along without polling.
  useEffect(
    () =>
      live.on((event) => {
        if (event.type === 'service.appupdate' && event.update.serviceId === service.id) {
          load();
        }
      }),
    [service.id, load],
  );

  if (!state) return <Spinner />;

  const running = state.history.find(
    (update) => update.status === 'backing-up' || update.status === 'deploying',
  );

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        Derailed backs this app up first, updates it, and checks it still answers. If it doesn't,
        the old version never stops serving, and one press puts things back the way they were.
      </p>

      {running ? (
        <div className="rounded-[var(--radius-card)] border border-line bg-sunken px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <Spinner />
            {running.status === 'backing-up'
              ? 'Taking a copy of the project first…'
              : 'Copy taken. Starting the new version and waiting for it to answer…'}
          </p>
        </div>
      ) : state.availability.available ? (
        <div className="rounded-[var(--radius-card)] border border-accent bg-accent-soft px-4 py-3">
          <p className="text-[13px] font-medium text-ink">A newer version is available.</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {service.image} has a newer build published
            {state.availability.current ? ` (running ${state.availability.current})` : ''}.
          </p>
          <button
            type="button"
            className="btn-primary mt-2"
            disabled={busy !== null}
            onClick={() => {
              setBusy('update');
              setError(null);
              endpoints
                .startAppUpdate(service.id)
                .then(() => load())
                .catch(setError)
                .finally(() => setBusy(null));
            }}
          >
            {busy === 'update' ? <Spinner /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
            Back up and update
          </button>
        </div>
      ) : (
        <p className="text-[13px] text-ink-faint">
          This app is on the newest published version of {service.image}.
        </p>
      )}

      <Switch
        label="Update automatically from now on"
        hint="Checked daily. Every automatic update takes the same backup first and rolls itself back if the new version does not answer."
        checked={state.autoUpdate}
        disabled={busy !== null}
        onChange={(next) => {
          setBusy('auto');
          setError(null);
          endpoints
            .setAppAutoUpdate(service.id, next)
            .then(() => load())
            .catch(setError)
            .finally(() => setBusy(null));
        }}
      />

      <ErrorNote error={error} />

      {state.history.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5">How past updates went</p>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {state.history.map((update) => (
              <li key={update.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] text-ink">
                    {new Date(update.createdAt).toLocaleString()}
                  </p>
                  <span
                    className={
                      update.status === 'ok'
                        ? 'text-[11px] font-medium text-ok'
                        : update.status === 'failed'
                          ? 'text-[11px] font-medium text-danger'
                          : 'text-[11px] font-medium text-ink-muted'
                    }
                  >
                    {label(update)}
                  </span>
                </div>
                {update.message && (
                  <p className="mt-0.5 text-[12px] text-ink-muted">{update.message}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.canRevert && !running && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => {
            setBusy('revert');
            setError(null);
            endpoints
              .revertAppUpdate(service.id)
              .then(() => {
                push({ message: 'Put back the way it was.', tone: 'ok' });
                load();
              })
              .catch(setError)
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'revert' ? <Spinner /> : <RotateCcw className="h-3.5 w-3.5" />}
          Put it back the way it was
        </button>
      )}

      <p className="text-[12px] text-ink-faint">
        Putting it back re-runs the exact version that was running before the last update. The data
        is not rolled back; the backup taken before the update is on the Backups page if you need
        it.
      </p>
    </div>
  );
}

function label(update: AppUpdate): string {
  switch (update.status) {
    case 'ok':
      return update.trigger === 'auto' ? 'updated itself' : 'updated';
    case 'failed':
      return 'did not take';
    case 'reverted':
      return 'put back';
    case 'backing-up':
      return 'backing up…';
    case 'deploying':
      return 'updating…';
  }
}
