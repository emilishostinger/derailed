import type { Service } from '@derailed/shared';
import { useState } from 'react';
import { FilesTab } from './FilesTab.tsx';
import { SiteEditorTab } from './SiteEditorTab.tsx';
import { cx } from './ui.tsx';

/**
 * One Files tab, whatever the app is.
 *
 * Files used to be two tabs that looked alike and were not: one edited the source a
 * dragged-in site is built and published from, the other browsed the storage volumes
 * an app keeps its data in. They shared a shape and confused people, so they are one
 * tab now, and this decides which thing "Files" means for this app:
 *
 * - A dragged-in site's files ARE its source, so that is what you get, with the real
 *   editor, a save that publishes, and the one-button 404 page.
 * - Every other app has no editable source (its code lives in git or an image), so
 *   Files is its storage: the folders whose contents survive a deploy.
 * - The rare app that is both a dragged-in site and has attached storage gets a small
 *   switch, so neither is hidden.
 *
 * The editor itself is the same component in both, so a file looks and behaves the
 * same wherever it is opened.
 */
export function FilesWorkspace({ service }: { service: Service }) {
  const hasSource = service.source === 'upload';
  const hasStorage = (service.volumes?.length ?? 0) > 0;
  const [view, setView] = useState<'site' | 'storage'>(hasSource ? 'site' : 'storage');

  if (hasSource && hasStorage) {
    return (
      <div className="space-y-3">
        <div className="inline-flex rounded-[var(--radius-control)] border border-line p-0.5 text-[12px]">
          {(
            [
              ['site', 'Site files'],
              ['storage', 'Stored data'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={cx(
                'rounded-[calc(var(--radius-control)-2px)] px-3 py-1 transition-colors',
                view === key ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink',
              )}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {view === 'site' ? <SiteEditorTab service={service} /> : <FilesTab service={service} />}
      </div>
    );
  }

  return hasSource ? <SiteEditorTab service={service} /> : <FilesTab service={service} />;
}
