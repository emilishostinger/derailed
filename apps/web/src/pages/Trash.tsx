import type { TrashItem } from '@derailed/shared';
import { Boxes, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { EmptyState, ErrorNote, Modal, Spinner } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { PageHeader } from './Layout.tsx';

/**
 * Things you deleted, and a week to change your mind.
 *
 * Deleting used to destroy the folders holding an app's data along with it. Now it
 * stops the app, frees its addresses, and leaves the data alone until this page
 * empties itself. The list says what is still there, because "put it back" is only
 * worth pressing if you know what comes back.
 */
export function Trash() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TrashItem | null>(null);
  const loadProjects = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .trash()
      .then(setItems)
      .catch((err) => {
        setError(err);
        setItems([]);
      });
  }, []);

  async function restore(item: TrashItem) {
    setBusy(item.id);
    setError(null);
    try {
      setItems(await endpoints.restoreFromTrash(item.kind, item.id));
      await loadProjects();
      push({
        message:
          item.kind === 'project'
            ? `${item.name} is back, and its apps are starting.`
            : `${item.name} is back and starting up.`,
        tone: 'ok',
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function purge(item: TrashItem) {
    setBusy(item.id);
    setError(null);
    try {
      setItems(await endpoints.purgeFromTrash(item.kind, item.id));
      push({ message: `${item.name} has been deleted for good.`, tone: 'danger' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  return (
    <>
      <PageHeader title="Trash" subtitle="Deleted things, kept for a week" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items === null ? (
          <div className="p-5">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Trash2 className="h-5 w-5" />}
            title="Nothing deleted"
            body="When you delete an app or a project it waits here for a week, with everything it stored, in case you want it back."
          />
        ) : (
          <div className="mx-auto max-w-2xl space-y-3 p-5">
            <ErrorNote error={error} />
            {items.map((item) => (
              <TrashRow
                key={`${item.kind}:${item.id}`}
                item={item}
                busy={busy === item.id}
                onRestore={() => void restore(item)}
                onPurge={() => setConfirming(item)}
              />
            ))}
          </div>
        )}
      </div>

      {confirming && (
        <Modal title={`Delete ${confirming.name} for good`} onClose={() => setConfirming(null)}>
          <div className="space-y-4">
            <p className="text-[13px] text-ink">
              This removes it and everything it stored, right now. There is no way back after this.
            </p>
            <ul className="space-y-1">
              {confirming.whatIsKept.map((line) => (
                <li key={line} className="text-[13px] text-ink-muted">
                  {line}
                </li>
              ))}
            </ul>
            <p className="hint">
              Doing nothing works too: it goes on its own {relative(confirming.purgeAt)}.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirming(null)}
                disabled={busy === confirming.id}
              >
                Keep it
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={busy === confirming.id}
                onClick={() => void purge(confirming)}
              >
                {busy === confirming.id && <Spinner />}
                Delete for good
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function TrashRow({
  item,
  busy,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">
          {item.name}
          {item.parentName && <span className="text-ink-faint"> in {item.parentName}</span>}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Deleted {relative(item.deletedAt)}. Still here: {item.whatIsKept.join(', ').toLowerCase()}
          .
        </p>
        <p className="mt-0.5 text-[12px] text-ink-faint">Goes for good {relative(item.purgeAt)}.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onRestore}>
          {busy ? <Spinner /> : <RotateCcw className="h-3.5 w-3.5" />}
          Put it back
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onPurge}>
          Delete now
        </button>
      </div>
    </div>
  );
}

/** "in 5 days", "2 hours ago". Plain words, since exact times are not the point here. */
function relative(at: number): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [seconds, 'second']
      : abs < 3600
        ? [Math.round(seconds / 60), 'minute']
        : abs < 86_400
          ? [Math.round(seconds / 3600), 'hour']
          : [Math.round(seconds / 86_400), 'day'];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit);
}
