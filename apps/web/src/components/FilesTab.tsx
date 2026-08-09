import type { FileEntry, Service } from '@derailed/shared';
import {
  ChevronLeft,
  Download,
  File,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { ContextMenu, useContextMenu } from './ContextMenu.tsx';
import { cx, ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * An app's stored files, without SSH.
 *
 * The storage half of the one Files tab (see `FilesTab.workspace.tsx`, which decides
 * whether "Files" means this or a dragged-in site's own source). It is scoped to the
 * folders attached as storage, which are also the only places whose contents survive
 * a deploy, so it is the only place worth editing anyway.
 *
 * Everything here can be done by dragging or by clicking. A file browser whose only
 * route to uploading is a drag is a file browser that half the people using it will
 * think cannot upload. The editor is the shared one, so a file looks the same here as
 * it does in a dragged-in site.
 */
export function FilesTab({ service }: { service: Service }) {
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

  const full = (entry: FileEntry) => `${path === '/' ? '' : path}/${entry.name}`;

  /**
   * Uploads run one after another rather than all at once. Ten parallel uploads
   * through a single Docker socket is not ten times faster, and the count only means
   * something if the things being counted finish in order.
   */
  const upload = useCallback(
    async (files: File[]) => {
      if (!path || files.length === 0) return;
      setError(null);
      setUploading({ done: 0, total: files.length });
      try {
        for (const [index, file] of files.entries()) {
          setUploading({ done: index, total: files.length });
          await endpoints.uploadFile(service.id, path, file);
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
    [load, path, push, service.id],
  );

  const save = useCallback(() => {
    if (!editing) return;
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
  }, [editing, push, service.id]);

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
            {busy ? <Spinner /> : <Save className="h-3.5 w-3.5" />}
            Save it
          </button>
        </div>
        {/* The same real editor the site editor uses, so a file looks the same
            wherever you open it: syntax highlighting, line numbers, Cmd-S to save. */}
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
          // Files only. A folder dropped here arrives as a directory entry with no
          // contents, and silently uploading nothing is worse than saying so.
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
                path={full(entry)}
                serviceId={service.id}
                onOpen={() => {
                  if (entry.directory) {
                    load(full(entry));
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  endpoints
                    .readFile(service.id, full(entry))
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
          onSubmit={(name) => endpoints.newFolder(service.id, path, name)}
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
          onSubmit={(name) => endpoints.renameFile(service.id, full(renaming), name)}
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
          onConfirm={() => endpoints.deleteFile(service.id, full(deleting))}
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
  path,
  serviceId,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: FileEntry;
  path: string;
  serviceId: string;
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
                    // A plain navigation, so the browser's own download machinery
                    // handles it and a 300 MB file never becomes a string here.
                    window.location.href = endpoints.downloadFileUrl(serviceId, path);
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
        {/* The only field in a modal that was opened in order to fill it in. */}
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
 * Apps go to the trash and can be put back for seven days. A file inside a running
 * container has nowhere to go, so this says so plainly rather than implying an undo
 * that the rest of the product has trained people to expect.
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
