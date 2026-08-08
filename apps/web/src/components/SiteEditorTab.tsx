import type { Service } from '@derailed/shared';
import { FileCode, FilePlus, Rocket } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { cx, EmptyState, ErrorNote, Spinner } from './ui.tsx';

/**
 * Edit a file, and it's live.
 *
 * The dragged-in site's own files, in a real editor, with a save that publishes
 * through the ordinary deploy pipeline. The first plain-language use is one button:
 * a page for when things go wrong, because every site should have a 404 that helps
 * people onward and almost none do.
 */
export function SiteEditorTab({ service }: { service: Service }) {
  const [files, setFiles] = useState<{ path: string; sizeBytes: number }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [contents, setContents] = useState('');
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'published'>('idle');
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    endpoints
      .sourceFiles(service.id)
      .then(setFiles)
      .catch((err) => {
        setFiles([]);
        setError(err);
      });
  }, [service.id]);

  useEffect(refresh, [refresh]);

  async function openFile(path: string) {
    setError(null);
    try {
      const file = await endpoints.readSource(service.id, path);
      setOpen(path);
      setContents(file.contents);
      setDirty(false);
      setState('idle');
    } catch (err) {
      setError(err);
    }
  }

  const save = useCallback(async () => {
    if (!open) return;
    setState('saving');
    setError(null);
    try {
      await endpoints.writeSource(service.id, open, contents);
      setDirty(false);
      setState('published');
      refresh();
    } catch (err) {
      setError(err);
      setState('idle');
    }
  }, [open, contents, service.id, refresh]);

  async function addErrorPage(kind: '404' | '500') {
    setError(null);
    try {
      const { contents: template } = await endpoints.errorPageTemplate(service.id, kind);
      setOpen(`${kind}.html`);
      setContents(template);
      setDirty(true);
      setState('idle');
    } catch (err) {
      setError(err);
    }
  }

  if (files === null) return <p className="hint">Loading…</p>;
  if (files.length === 0 && !open) {
    return (
      <EmptyState
        icon={<FileCode className="h-5 w-5" />}
        title="Nothing uploaded yet"
        body="Drag your folder or a zip onto the app first, then edit any file here and save it straight to the live site."
      />
    );
  }

  const has404 = files.some((file) => file.path === '404.html');
  const has500 = files.some((file) => file.path === '500.html');

  return (
    <div className="flex h-[32rem] min-h-0 flex-col gap-3">
      {(!has404 || !has500) && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface-2 px-3 py-2">
          <p className="min-w-0 flex-1 text-[12px] text-ink-muted">
            A page called 404.html or 500.html at the site's root is shown to visitors when things
            go wrong, automatically.
          </p>
          {!has404 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void addErrorPage('404')}
            >
              <FilePlus className="h-3.5 w-3.5" />
              Add a 404 page
            </button>
          )}
          {!has500 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void addErrorPage('500')}
            >
              <FilePlus className="h-3.5 w-3.5" />
              Add a 500 page
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="w-52 shrink-0 overflow-y-auto rounded-[var(--radius-card)] border border-line">
          <ul>
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className={cx(
                    'flex w-full items-center gap-2 border-line border-b px-2.5 py-1.5 text-left font-mono text-[11px] last:border-0',
                    open === file.path
                      ? 'bg-accent/10 text-ink'
                      : 'text-ink-muted hover:bg-surface-2',
                  )}
                  onClick={() => void openFile(file.path)}
                >
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col rounded-[var(--radius-card)] border border-line">
          {open ? (
            <>
              <div className="flex items-center gap-2 border-line border-b px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                  {open}
                </span>
                {state === 'published' && !dirty && (
                  <span className="text-[12px] text-ok">Saved, publishing…</span>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!dirty || state === 'saving'}
                  onClick={() => void save()}
                >
                  {state === 'saving' ? <Spinner /> : <Rocket className="h-3.5 w-3.5" />}
                  Save and publish
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  value={contents}
                  filename={open}
                  onChange={(next) => {
                    setContents(next);
                    setDirty(true);
                  }}
                  onSave={() => void save()}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-ink-faint">
              Pick a file to edit. Saving publishes the site.
            </div>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
