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
  const [state, setState] = useState<{ enabled: boolean; previews: Service[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .previews(service.id)
      .then(setState)
      .catch(() => undefined);
  }, [service.id]);

  useEffect(load, [load]);

  if (!state || !service.repoUrl) return null;

  return (
    <div>
      <Switch
        checked={state.enabled}
        label="Give every branch its own copy"
        hint="Push a branch and it gets its own running copy with its own address, sharing this app's database. It goes when the branch does."
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
