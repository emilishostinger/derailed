import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * Variables every app in a project gets.
 *
 * An API key, a timezone, an error-reporting address: things that are true of the
 * project rather than of one app in it. Setting the same value on five apps by hand
 * is five chances to fat-finger one, and rotating it later means finding all five and
 * remembering which they were.
 *
 * An app's own variable of the same name wins, so this is a default rather than a
 * decree. That direction is the whole design: the other way round, a shared list
 * becomes a thing you have to fight the moment one app is different.
 */
export function SharedVariables({
  id,
  name,
  onClose,
}: {
  id: string;
  name: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ key: string; value: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .projectEnv(id)
      .then(setRows)
      .catch((err) => {
        setError(err);
        setRows([]);
      });
  }, [id]);

  const update = (index: number, patch: Partial<{ key: string; value: string }>) =>
    setRows((current) =>
      (current ?? []).map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );

  return (
    <Modal
      title="Shared variables"
      subtitle={`Given to every app in ${name}, unless the app sets its own.`}
      wide
      onClose={onClose}
    >
      <div className="space-y-3">
        {rows === null ? (
          <Spinner />
        ) : (
          <>
            {rows.length === 0 ? (
              <p className="text-[13px] text-ink-faint">
                Nothing shared yet. Anything you add here is set on every app in this project, so
                you only have to change it in one place later.
              </p>
            ) : (
              <div className="space-y-1.5">
                {rows.map((row, index) => (
                  // Position is the identity while editing: two rows can hold the same
                  // half-typed name for as long as it takes to finish typing.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <div key={index} className="flex gap-2">
                    <input
                      className="input w-1/3 font-mono text-[13px]"
                      value={row.key}
                      placeholder="SENTRY_DSN"
                      onChange={(event) => update(index, { key: event.target.value })}
                    />
                    <input
                      className="input flex-1 font-mono text-[13px]"
                      value={row.value}
                      onChange={(event) => update(index, { value: event.target.value })}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${row.key || 'this variable'}`}
                      className="btn-ghost shrink-0 px-2 text-ink-faint hover:text-danger"
                      onClick={() =>
                        setRows((current) => (current ?? []).filter((_, at) => at !== index))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              className="btn-ghost"
              onClick={() => setRows((current) => [...(current ?? []), { key: '', value: '' }])}
            >
              <Plus className="h-3.5 w-3.5" />
              Add one
            </button>
          </>
        )}

        <ErrorNote error={error} />

        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-[12px] text-ink-faint">
            Apps pick these up on their next deploy, like any other variable.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || rows === null}
              onClick={() => {
                setBusy(true);
                setError(null);
                endpoints
                  .saveProjectEnv(
                    id,
                    (rows ?? []).filter((row) => row.key.trim()),
                  )
                  .then((saved) => {
                    setRows(saved);
                    push({ message: 'Saved. Redeploy for apps to pick them up.', tone: 'ok' });
                    void load();
                    onClose();
                  })
                  .catch(setError)
                  .finally(() => setBusy(false));
              }}
            >
              {busy && <Spinner />}
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
