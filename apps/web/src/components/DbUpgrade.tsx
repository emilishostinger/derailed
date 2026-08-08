import type { DbUpgrade, Service } from '@derailed/shared';
import { ArrowUpCircle, History } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Modal, Select, Spinner, Switch } from './ui.tsx';

type UpgradeState = Awaited<ReturnType<typeof endpoints.dbUpgradeState>>;

/**
 * Growing a database up without it being anyone's afternoon: a copy first, the
 * new engine proving itself on a fresh volume, and the old engine kept for a
 * week. The card leads with the promises, because the version number is not the
 * scary part; the move is.
 */
export function DbUpgradeCard({ service }: { service: Service }) {
  const [state, setState] = useState<UpgradeState | null>(null);
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    endpoints.dbUpgradeState(service.id).then(setState).catch(setError);
  }, [service.id]);

  useEffect(load, [load]);
  useEffect(
    () =>
      live.on((event) => {
        if (event.type === 'service.dbupgrade' && event.upgrade.serviceId === service.id) load();
      }),
    [service.id, load],
  );

  if (!state) return null;

  const running = state.history.find(
    (upgrade) => upgrade.status === 'copying' || upgrade.status === 'switching',
  );
  const shown = target || state.targets[0] || '';

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-4">
      <p className="eyebrow">Grow up safely</p>

      {running ? (
        <p className="flex items-center gap-2 text-[13px] text-ink">
          <Spinner />
          {running.status === 'copying'
            ? 'Taking a copy first…'
            : `Moving to ${state.engine} ${running.toVersion}. The old engine is untouched until the new one proves itself.`}
        </p>
      ) : state.targets.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          {state.engine} {state.current} is the newest version Derailed runs. Nothing to do.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-ink-muted">
            {state.engine} {state.current} can move up. Derailed takes a copy first, starts the new
            version beside the old one, reloads the copy into it, and only then switches. The old
            engine stays on the server, stopped, for a week.
          </p>
          <div className="flex items-end gap-2">
            <div className="w-44">
              <Select
                ariaLabel="Version to move to"
                value={shown}
                options={state.targets.map((version) => ({
                  value: version,
                  label: `${state.engine} ${version}`,
                }))}
                onChange={setTarget}
              />
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" />
              Move up
            </button>
          </div>
        </>
      )}

      <ErrorNote error={error} />

      {state.history.length > 0 && (
        <ul className="space-y-1">
          {state.history.slice(0, 5).map((upgrade) => (
            <li key={upgrade.id} className="flex items-start gap-2 text-[12px]">
              <History className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
              <span className="text-ink-muted">
                {new Date(upgrade.createdAt).toLocaleString()}: {describe(upgrade)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <Modal
          title={`Move to ${state.engine} ${shown}?`}
          subtitle="A copy is taken first, and the old engine is kept for a week."
          onClose={() => setConfirming(false)}
        >
          <div className="space-y-3">
            <p className="text-[13px] text-ink-muted">
              Apps stay connected: the address and password do not change. The database is briefly
              unavailable while the new engine loads the copy; for most databases that is under a
              minute.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
                Not now
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  endpoints
                    .startDbUpgrade(service.id, shown)
                    .then(() => {
                      setConfirming(false);
                      load();
                    })
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                {busy && <Spinner />}
                Take a copy and move
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function describe(upgrade: DbUpgrade): string {
  if (upgrade.fromVersion === upgrade.toVersion) {
    return upgrade.message ?? 'wound back to a moment';
  }
  switch (upgrade.status) {
    case 'ok':
      return `moved from ${upgrade.fromVersion} to ${upgrade.toVersion}`;
    case 'failed':
      return upgrade.message ?? `the move to ${upgrade.toVersion} did not take`;
    default:
      return `moving to ${upgrade.toVersion}…`;
  }
}

type PitrInfo = Awaited<ReturnType<typeof endpoints.pitrState>>;

/**
 * The honest point-in-time block, shown beside the hourly copies. Postgres gets
 * the real thing; everything else keeps the sentence about hourly copies, which
 * is the truth.
 */
export function PitrPanel({ service }: { service: Service }) {
  const [state, setState] = useState<PitrInfo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [moment, setMoment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints.pitrState(service.id).then(setState).catch(setError);
  }, [service.id]);

  useEffect(load, [load]);
  if (!state?.supported) return null;

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-4">
      <p className="eyebrow">To the second</p>
      <Switch
        label="Keep every change"
        hint="Postgres writes a log of every change; keeping a week of it means a restore can land on a moment, not just on the nearest copy. Costs disk in proportion to how much the database writes."
        checked={state.enabled}
        disabled={busy}
        onChange={(next) => {
          setBusy(true);
          setError(null);
          endpoints
            .setPitr(service.id, next)
            .then(setState)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      />
      {state.enabled && (
        <>
          <p className="text-[12px] text-ink-faint">
            {state.oldestMoment
              ? `Can restore to any moment since ${new Date(state.oldestMoment).toLocaleString()}. The archive is using ${formatBytes(state.sizeBytes)}.`
              : 'The first full copy is being taken; the restore range starts when it finishes.'}
          </p>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !state.oldestMoment}
            onClick={() => {
              setMoment(toLocalInput(new Date()));
              setRestoring(true);
            }}
          >
            Wind back to a moment
          </button>
        </>
      )}
      <ErrorNote error={error} />

      {restoring && (
        <Modal
          title="Wind back to when?"
          subtitle="The database will hold exactly what it held at that moment."
          onClose={() => setRestoring(false)}
        >
          <div className="space-y-3">
            <input
              type="datetime-local"
              className="input"
              value={moment}
              onChange={(event) => setMoment(event.target.value)}
            />
            <p className="text-[13px] text-ink-muted">
              Everything written after that moment is set aside, not destroyed: what the database
              holds right now is kept, stopped, for a week.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setRestoring(false)}>
                Leave it alone
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={busy || !moment}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  endpoints
                    .pitrRestore(service.id, new Date(moment).getTime())
                    .then(() => {
                      push({ message: 'Winding back. The result lands as a notice.', tone: 'ok' });
                      setRestoring(false);
                    })
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                {busy && <Spinner />}
                Wind it back
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
