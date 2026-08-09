import type { FileEntry } from '@derailed/shared';
import {
  ChevronLeft,
  Download,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Rocket,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { ContextMenu, useContextMenu } from './ContextMenu.tsx';
import { cx, ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * One file browser, whatever the files are.
 *
 * There used to be two: a rich folder browser for an app's storage, and a plainer
 * flat editor for a dragged-in site's source. They looked and behaved differently in
 * the same "Files" tab, which is confusing for exactly the reason it should be: they
 * are the same thing to a person, "the files of my app", and only differ in where the
 * bytes live. So there is one component now, and the difference is a small `adapter`
 * that says how to list, read, write, move and remove, nothing about how it looks.
 *
 * Everything can be done by dragging or by clicking. A file browser whose only route
 * to uploading is a drag is one half its users will think cannot upload.
 */
export interface FileAdapter {
  list(path?: string): Promise<{ roots: string[]; path: string | null; entries: FileEntry[] }>;
  read(path: string): Promise<string>;
  /** Returns anything; a site's write also kicks a deploy on the server. */
  write(path: string, contents: string): Promise<unknown>;
  makeFolder(path: string, name: string): Promise<unknown>;
  rename(path: string, name: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  upload(path: string, file: File): Promise<unknown>;
  downloadUrl(path: string): string;
}

export function FileBrowser({
  adapter,
  publish,
  errorPage,
  emptyState,
}: {
  adapter: FileAdapter;
  /** "Save and publish" instead of "Save it", for a site whose save deploys. */
  publish?: boolean;
  /** Site-only: a starter 404/500 page, and the buttons that add one. */
  errorPage?: (kind: '404' | '500') => Promise<string>;
  /** Shown when the whole thing is empty, e.g. an app with no storage attached. */
  emptyState?: ReactNode;
}) {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [editing, setEditing] = useState<{ path: string; contents: string } | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(
    (next?: string) => {
      setBusy(true);
      setError(null);
      adapter
        .list(next)
        .then((result) => {
          setRoots(result.roots);
          setPath(result.path);
          setEntries(result.entries);
        })
        .catch(setError)
        .finally(() => setBusy(false));
    },
    [adapter],
  );

  useEffect(() => load(), [load]);

  const full = (entry: FileEntry) => `${path === '/' ? '' : path}/${entry.name}`;

  const upload = useCallback(
    async (files: File[]) => {
      if (!path || files.length === 0) return;
      setError(null);
      setUploading({ done: 0, total: files.length });
      try {
        for (const [index, file] of files.entries()) {
          setUploading({ done: index, total: files.length });
          await adapter.upload(path, file);
        }
        push({
          message: files.length === 1 ? `${files[0]?.name} uploaded.` : `${files.length} uploaded.`,
          tone: 'ok',
        });
        load(path);
      } catch (err) {
        setError(err);
      } finally {
        setUploading(null);
      }
    },
    [adapter, load, path, push],
  );

  const save = useCallback(() => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    adapter
      .write(editing.path, editing.contents)
      .then(() => {
        push({ message: publish ? 'Saved, publishing…' : 'Saved.', tone: 'ok' });
        setEditing(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  }, [adapter, editing, publish, push]);

  const openErrorPage = useCallback(
    async (kind: '404' | '500') => {
      if (!errorPage) return;
      setError(null);
      const name = `${kind}.html`;
      // Edit the existing one if it is there, otherwise start from the template.
      const existing = await adapter.read(name).catch(() => null);
      setEditing({ path: name, contents: existing ?? (await errorPage(kind)) });
    },
    [adapter, errorPage],
  );

  if (editing) {
    return (
      <div className="flex h-[32rem] min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
            {editing.path}
          </p>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>
            {busy ? (
              <Spinner />
            ) : publish ? (
              <Rocket className="h-3.5 w-3.5" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {publish ? 'Save and publish' : 'Save it'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-card)] border border-line">
          <CodeEditor
            value={editing.contents}
            filename={editing.path}
            onChange={(next) =>
              setEditing((current) => (current ? { ...current, contents: next } : current))
            }
            onSave={save}
          />
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  const atRoot = path !== null && roots.includes(path);
  const parent = path && !atRoot ? path.slice(0, path.lastIndexOf('/')) || '/' : null;

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

      {errorPage && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface-2 px-3 py-2">
          <p className="min-w-0 flex-1 text-[12px] text-ink-muted">
            A page called 404.html or 500.html at the site's root is shown to visitors when things
            go wrong, automatically.
          </p>
          <button type="button" className="btn-secondary" onClick={() => void openErrorPage('404')}>
            <FilePlus className="h-3.5 w-3.5" />
            404 page
          </button>
          <button type="button" className="btn-secondary" onClick={() => void openErrorPage('500')}>
            <FilePlus className="h-3.5 w-3.5" />
            500 page
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {parent && (
          <button type="button" className="btn-ghost" onClick={() => load(parent)}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Up
          </button>
        )}
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">{path}</p>
        <button
          type="button"
          className="btn-ghost"
          disabled={!path || uploading !== null}
          onClick={() => setCreating(true)}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={!path || uploading !== null}
          onClick={() => chooser.current?.click()}
        >
          {uploading ? <Spinner /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? `Uploading ${uploading.done + 1} of ${uploading.total}` : 'Upload'}
        </button>
        <input
          ref={chooser}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void upload([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>

      <ErrorNote error={error} />

      {/** biome-ignore lint/a11y/noStaticElementInteractions: a drop target, not a control. */}
      <div
        onDragOver={(event) => {
          if (!path || uploading) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          const dropped = [...event.dataTransfer.files];
          if (dropped.length === 0) return;
          void upload(dropped);
        }}
        className={cx(
          'rounded-[var(--radius-card)] transition-colors',
          dropping && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
        )}
      >
        {busy || entries === null ? (
          <Spinner />
        ) : entries.length === 0 && atRoot && emptyState ? (
          emptyState
        ) : entries.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-line border-dashed px-3 py-8 text-center text-[13px] text-ink-faint">
            This folder is empty. Drop a file on it, or use Upload.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {entries.map((entry) => (
              <Row
                key={entry.name}
                entry={entry}
                downloadUrl={adapter.downloadUrl(full(entry))}
                onOpen={() => {
                  if (entry.directory) {
                    load(full(entry));
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  adapter
                    .read(full(entry))
                    .then((contents) => setEditing({ path: full(entry), contents }))
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
                onRename={() => setRenaming(entry)}
                onDelete={() => setDeleting(entry)}
              />
            ))}
          </ul>
        )}
      </div>

      {creating && path && (
        <NameModal
          title="New folder"
          subtitle={`Inside ${path}`}
          action="Create it"
          onClose={() => setCreating(false)}
          onSubmit={(name) => adapter.makeFolder(path, name)}
          onDone={(name) => {
            push({ message: `${name} created.`, tone: 'ok' });
            setCreating(false);
            load(path);
          }}
        />
      )}

      {renaming && (
        <NameModal
          title={`Rename ${renaming.name}`}
          action="Rename it"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => adapter.rename(full(renaming), name)}
          onDone={() => {
            push({ message: 'Renamed.', tone: 'ok' });
            setRenaming(null);
            if (path) load(path);
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          entry={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => adapter.remove(full(deleting))}
          onDone={() => {
            push({ message: `${deleting.name} deleted.`, tone: 'ok' });
            setDeleting(null);
            if (path) load(path);
          }}
        />
      )}
    </div>
  );
}

function Row({
  entry,
  downloadUrl,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: FileEntry;
  downloadUrl: string;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const menu = useContextMenu();

  return (
    <li className="relative">
      {/** biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut to the same menu the button opens. */}
      <div className="flex items-center hover:bg-surface-2" onContextMenu={menu.onContextMenu}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
          onClick={onOpen}
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
        <button
          type="button"
          aria-label={`More for ${entry.name}`}
          className={cx('btn-ghost mr-1.5 px-1.5', menu.isOpen && 'bg-surface-2 text-ink')}
          onClick={menu.openFrom}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      <ContextMenu
        at={menu.at}
        onClose={menu.close}
        items={[
          ...(entry.directory
            ? []
            : [
                {
                  label: 'Download',
                  icon: <Download className="h-3.5 w-3.5" />,
                  onSelect: () => {
                    window.location.href = downloadUrl;
                  },
                },
              ]),
          { label: 'Rename', icon: <Pencil className="h-3.5 w-3.5" />, onSelect: onRename },
          {
            label: 'Delete',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            separated: true,
            onSelect: onDelete,
          },
        ]}
      />
    </li>
  );
}

/** One text box and a button, for both renaming and creating. */
function NameModal({
  title,
  subtitle,
  action,
  initial = '',
  onClose,
  onSubmit,
  onDone,
}: {
  title: string;
  subtitle?: string;
  action: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSubmit(name.trim())
      .then(() => onDone(name.trim()))
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="space-y-3">
        <input
          autoFocus
          className="input font-mono text-[13px]"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
            {busy && <Spinner />}
            {action}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Deleting a file here is not the same as deleting an app.
 *
 * Apps go to the trash and can be put back for seven days. A file has nowhere to go,
 * so this says so plainly rather than implying an undo the rest of the product trains
 * people to expect.
 */
function DeleteModal({
  entry,
  onClose,
  onConfirm,
  onDone,
}: {
  entry: FileEntry;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <Modal
      title={`Delete ${entry.name}?`}
      subtitle={
        entry.directory
          ? 'This folder and everything in it. There is no undo for files.'
          : 'There is no undo for files.'
      }
      onClose={onClose}
    >
      <div className="space-y-3">
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onConfirm()
                .then(onDone)
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy && <Spinner />}
            Delete it
          </button>
        </div>
      </div>
    </Modal>
  );
}
