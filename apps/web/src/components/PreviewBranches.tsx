import type { Service } from '@derailed/shared';
import { GitBranch } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner, Switch } from './ui.tsx';

/**
 * A copy of this app for every branch.
 *
 * The flagship feature of every platform people pay twenty pounds a month for. Every
 * piece was already here; the only new idea is that a branch is a temporary copy of
 * an app, and it goes when the branch does.
 */
export function PreviewBranches({ service }: { service: Service }) {
  const [state, setState] = useState<{
    enabled: boolean;
    mode: 'shared' | 'clone';
    scrub: string | null;
    previews: Service[];
  } | null>(null);
  const [scrub, setScrub] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .previews(service.id)
      .then((answer) => {
        setState(answer);
        setScrub(answer.scrub ?? '');
      })
      .catch(() => undefined);
  }, [service.id]);

  useEffect(load, [load]);

  if (!state || !service.repoUrl) return null;

  return (
    <div>
      <Switch
        checked={state.enabled}
        label="Give every branch its own copy"
        hint="Push a branch and it gets its own running copy with its own address. It goes when the branch does."
        disabled={busy}
        onChange={async (next) => {
          setBusy(true);
          setError(null);
          try {
            await endpoints.setPreviews(service.id, next);
            setState({ ...state, enabled: next });
            push({
              message: next
                ? 'On. Branches will start appearing within about five minutes.'
                : 'Off. The copies already made are in the trash.',
              tone: 'ok',
            });
            load();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />

      {state.enabled && (
        <div className="mt-3 space-y-2">
          <select
            className="input"
            value={state.mode}
            disabled={busy}
            onChange={(event) => {
              const mode = event.target.value as 'shared' | 'clone';
              setBusy(true);
              setError(null);
              endpoints
                .setPreviewData(service.id, mode)
                .then(() => setState((s) => (s ? { ...s, mode } : s)))
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            <option value="shared">Previews share this app's real database</option>
            <option value="clone">Each preview gets its own copy of the data</option>
          </select>
          {state.mode === 'clone' && (
            <>
              <p className="text-[12px] text-ink-faint">
                The copy comes from the newest hourly copy of each linked database, or one taken on
                the spot. The preview can do anything to it; the real data never notices. Copies nap
                after a quiet day and go when the branch does.
              </p>
              <div className="flex gap-2">
                <input
                  className="input flex-1 font-mono text-[12px]"
                  placeholder="Optional: a command run against each copy before it serves"
                  value={scrub}
                  onChange={(event) => setScrub(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    endpoints
                      .setPreviewData(service.id, 'clone', scrub || null)
                      .then(() => push({ message: 'Saved.', tone: 'ok' }))
                      .catch(setError)
                      .finally(() => setBusy(false));
                  }}
                >
                  Save
                </button>
              </div>
              <p className="text-[12px] text-ink-faint">
                For real-shaped data without real people in it: the command runs inside the copy's
                own container, and a scrub that fails throws the whole copy away rather than serving
                it anyway.
              </p>
            </>
          )}
        </div>
      )}

      {state.previews.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {state.previews.map((preview) => (
            <li key={preview.id} className="flex items-center gap-2 text-[12px]">
              <GitBranch className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="text-ink">{preview.branch}</span>
              <span className="truncate text-ink-faint">
                {(preview.domains ?? [])[0]?.hostname ?? 'starting up'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {busy && <Spinner />}
      <ErrorNote error={error} />
    </div>
  );
}
