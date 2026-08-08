import type { PendingChange } from '@derailed/shared';
import { Check, ClipboardList, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Modal, Spinner, Switch } from './ui.tsx';

/**
 * What will change.
 *
 * The one honest screen between editing and production: what is waiting, what each
 * edit will do said in a diff a person can read, one Apply for all of it, and a
 * discard for the edit that should never have been staged. Values of variables
 * appear nowhere here; which keys move is the story.
 */
export function PendingChangesDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);
  const [review, setReview] = useState<boolean | null>(null);
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    endpoints
      .pendingChanges(projectId)
      .then((state) => {
        setReview(state.reviewChanges);
        setChanges(state.changes);
      })
      .catch(setError);
  }, [projectId]);

  useEffect(refresh, [refresh]);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.applyPendingChanges(projectId);
      const bad = result.results.filter((entry) => !entry.ok);
      setFailed(new Map(bad.map((entry) => [entry.id, entry.note ?? 'It did not apply.'])));
      if (bad.length === 0) {
        push({
          message: result.redeployNeeded
            ? 'Applied. Redeploy the affected apps for variables to take effect.'
            : 'Applied.',
          tone: 'ok',
        });
        void load();
        onClose();
      } else {
        refresh();
        void load();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="What will change" subtitle={projectName} onClose={onClose} wide>
      <div className="space-y-4">
        {review !== null && (
          <Switch
            label="Collect changes for review"
            hint="Edits to variables, settings and domains wait here and apply together, instead of landing as they are saved."
            checked={review}
            onChange={(enabled) => {
              setReview(enabled);
              endpoints
                .setReviewChanges(projectId, enabled)
                .then(() => void load())
                .catch(setError);
            }}
          />
        )}

        {changes.length === 0 ? (
          <p className="hint">
            Nothing is waiting. {review ? 'Edits will collect here as they are saved.' : ''}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {changes.map((change) => (
              <li key={change.id} className="flex items-start gap-3 p-3.5">
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{change.summary}</p>
                  <ul className="mt-1 space-y-0.5">
                    {change.diff.map((line) => (
                      <li key={line} className="font-mono text-[11px] text-ink-muted">
                        {line}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {new Date(change.createdAt).toLocaleString()}
                    {change.createdBy ? ` · ${change.createdBy}` : ''}
                  </p>
                  {failed.has(change.id) && (
                    <p className="mt-1 flex items-center gap-1 text-[12px] text-danger">
                      <X className="h-3 w-3" /> {failed.get(change.id)}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-ghost shrink-0 text-danger"
                  title="Discard this change"
                  onClick={() => {
                    endpoints
                      .discardPendingChange(projectId, change.id)
                      .then(refresh)
                      .catch(setError);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {changes.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="btn-ghost text-danger"
              disabled={busy}
              onClick={() => {
                endpoints.discardPendingChange(projectId).then(refresh).catch(setError);
              }}
            >
              Discard all
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? <Spinner /> : <Check className="h-3.5 w-3.5" />}
              Apply {changes.length === 1 ? 'it' : `all ${changes.length} together`}
            </button>
          </div>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/**
 * The quiet reminder on the project page: "3 changes waiting". Absent entirely
 * when nothing is, so a project that never uses review never sees it.
 */
export function PendingChangesBar({
  projectId,
  onOpen,
  refreshSignal,
}: {
  projectId: string;
  onOpen: () => void;
  /** Any changing value; the bar refetches when it moves. */
  refreshSignal?: unknown;
}) {
  const [count, setCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSignal exists purely to trigger the refetch.
  useEffect(() => {
    endpoints
      .pendingChanges(projectId)
      .then((state) => setCount(state.changes.length))
      .catch(() => undefined);
  }, [projectId, refreshSignal]);

  if (count === 0) return null;
  return (
    <button
      type="button"
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-accent/40 bg-surface px-4 py-2 text-[13px] text-ink shadow-lg transition-colors hover:bg-surface-2"
      onClick={onOpen}
    >
      <ClipboardList className="h-4 w-4 text-accent" />
      {count} change{count === 1 ? '' : 's'} waiting
      <span className="text-ink-muted">· review and apply together</span>
    </button>
  );
}
