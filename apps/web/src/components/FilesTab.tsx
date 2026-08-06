import type { FileEntry, Service } from '@derailed/shared';
import { ChevronLeft, File, Folder, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * An app's files, without SSH.
 *
 * For the WordPress-and-PHP audience, which is the largest self-hosting audience
 * there is, this is the hosting-panel feature they will look for first. It is scoped
 * to the folders attached as storage, which are also the only places whose contents
 * survive a deploy, so it is the only place worth editing anyway.
 */
export function FilesTab({ service }: { service: Service }) {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [editing, setEditing] = useState<{ path: string; contents: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(
    (next?: string) => {
      setBusy(true);
      setError(null);
      endpoints
        .files(service.id, next)
        .then((result) => {
          setRoots(result.roots);
          setPath(result.path);
          setEntries(result.entries);
        })
        .catch(setError)
        .finally(() => setBusy(false));
    },
    [service.id],
  );

  useEffect(() => load(), [load]);

  if ((service.volumes?.length ?? 0) === 0) {
    return (
      <p className="text-[13px] text-ink-faint">
        This app has no storage attached, so there are no files that outlive a deploy. Add some on
        the Storage tab.
      </p>
    );
  }

  const atRoot = path !== null && roots.includes(path);
  const parent = path && !atRoot ? path.slice(0, path.lastIndexOf('/')) || '/' : null;

  if (editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
            {editing.path}
          </p>
        </div>
        <textarea
          className="input h-96 font-mono text-[12px]"
          value={editing.contents}
          onChange={(event) => setEditing({ ...editing, contents: event.target.value })}
        />
        <ErrorNote error={error} />
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            endpoints
              .writeFile(service.id, editing.path, editing.contents)
              .then(() => {
                push({ message: 'Saved.', tone: 'ok' });
                setEditing(null);
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : <Save className="h-3.5 w-3.5" />}
          Save it
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {roots.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {roots.map((root) => (
            <button
              key={root}
              type="button"
              className="btn-ghost font-mono text-[12px]"
              onClick={() => load(root)}
            >
              {root}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {parent && (
          <button type="button" className="btn-ghost" onClick={() => load(parent)}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Up
          </button>
        )}
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">{path}</p>
      </div>

      <ErrorNote error={error} />

      {busy || entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-ink-faint">This folder is empty.</p>
      ) : (
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {entries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                onClick={() => {
                  const full = `${path === '/' ? '' : path}/${entry.name}`;
                  if (entry.directory) {
                    load(full);
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  endpoints
                    .readFile(service.id, full)
                    .then((contents) => setEditing({ path: full, contents }))
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                {entry.directory ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
                {!entry.directory && (
                  <span className="shrink-0 text-[12px] text-ink-faint tabular">
                    {formatBytes(entry.sizeBytes)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
