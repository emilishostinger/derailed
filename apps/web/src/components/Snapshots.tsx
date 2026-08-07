import type { Service } from '@derailed/shared';
import { Camera, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Modal, Select, Spinner } from './ui.tsx';

type State = Awaited<ReturnType<typeof endpoints.snapshots>>;

/**
 * Copies of one database, taken often.
 *
 * "The bad thing happened at three and the backup is from midnight" is the worst hour
 * of somebody's month, and the answer is not a better nightly backup, it is more of
 * them.
 *
 * The page is careful not to call this point-in-time recovery, because it is not.
 * Real PITR replays a write-ahead log to an arbitrary second and needs the database
 * configured to keep that log. This puts back the nearest copy at or before a moment,
 * so what it bounds is how much you lose. Saying which one you get, out loud, is the
 * difference between a feature people trust and one they find out about at the worst
 * possible time.
 */
export function Snapshots({ service }: { service: Service }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<{ id: string; at: number } | null>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .snapshots(service.id)
      .then(setState)
      .catch(() => setState({ snapshots: [], everyHours: null, intervals: [1, 6, 12] }));
  }, [service.id]);

  useEffect(load, [load]);
  if (!state) return null;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        A copy of this database on its own, kept on a short rolling window, so losing an afternoon
        does not mean going back to last night's backup.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <p className="eyebrow mb-1.5">Take one</p>
          <Select
            ariaLabel="How often to take a copy"
            value={state.everyHours === null ? 'off' : String(state.everyHours)}
            options={[
              { value: 'off', label: 'Never' },
              ...state.intervals.map((hours) => ({
                value: String(hours),
                label: hours === 1 ? 'Every hour' : `Every ${hours} hours`,
              })),
            ]}
            onChange={(value) => {
              setBusy('interval');
              setError(null);
              endpoints
                .setSnapshotInterval(service.id, value === 'off' ? null : Number(value))
                .then(load)
                .catch(setError)
                .finally(() => setBusy(null));
            }}
          />
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => {
            setBusy('now');
            setError(null);
            endpoints
              .takeSnapshot(service.id)
              .then(() => {
                push({ message: 'Copied.', tone: 'ok' });
                load();
              })
              .catch(setError)
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'now' ? <Spinner /> : <Camera className="h-3.5 w-3.5" />}
          Take one now
        </button>
      </div>

      <ErrorNote error={error} />

      {state.snapshots.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          No copies yet. Take one now, or pick an interval and the first arrives shortly.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {state.snapshots.map((snapshot) => (
            <li key={snapshot.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">{new Date(snapshot.at).toLocaleString()}</p>
                <p className="text-[12px] text-ink-faint">{formatBytes(snapshot.sizeBytes)}</p>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0"
                disabled={busy !== null}
                onClick={() => setConfirming({ id: snapshot.id, at: snapshot.at })}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Put this back
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[12px] text-ink-faint">
        Putting a copy back replaces what is in the database now with what was in it then.
        Everything written since is gone, which is the point, and there is no undo for it.
      </p>

      {confirming && (
        <Modal
          title="Put this copy back?"
          subtitle={`The database will hold exactly what it held at ${new Date(confirming.at).toLocaleString()}.`}
          onClose={() => setConfirming(null)}
        >
          <div className="space-y-3">
            <p className="text-[13px] text-ink-muted">
              Everything written since then is gone. Nothing else on the server is touched, and apps
              connected to this database keep running: they will simply see the older data.
            </p>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                Leave it alone
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('restore');
                  setError(null);
                  endpoints
                    .restoreSnapshot(service.id, confirming.id)
                    .then(() => {
                      push({ message: 'Put back.', tone: 'ok' });
                      setConfirming(null);
                      load();
                    })
                    .catch(setError)
                    .finally(() => setBusy(null));
                }}
              >
                {busy === 'restore' && <Spinner />}
                Put it back
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
