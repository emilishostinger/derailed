import type { Service } from '@derailed/shared';
import { useMemo, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { type FileAdapter, FileBrowser } from './FileBrowser.tsx';
import { cx } from './ui.tsx';

/**
 * One Files tab, one look, whatever the app is.
 *
 * "My files" means one of two things depending on the app, and it used to be two
 * tabs that looked and behaved differently, which is the confusing part: they are
 * the same thing to a person. So there is one browser (`FileBrowser`) and this only
 * chooses where its bytes come from:
 *
 * - A dragged-in site's files ARE its source, so Files edits them and a save
 *   publishes, with the one-button 404 page.
 * - Every other app has no editable source (git or an image is the truth), so Files
 *   is its storage: the folders whose contents survive a deploy.
 * - The rare app that is both gets a small Site files / Stored data switch.
 *
 * The browser is identical in every case; only the adapter differs.
 */

function storageAdapter(serviceId: string): FileAdapter {
  return {
    list: (path) => endpoints.files(serviceId, path),
    read: (path) => endpoints.readFile(serviceId, path),
    write: (path, contents) => endpoints.writeFile(serviceId, path, contents),
    makeFolder: (path, name) => endpoints.newFolder(serviceId, path, name),
    rename: (path, name) => endpoints.renameFile(serviceId, path, name),
    remove: (path) => endpoints.deleteFile(serviceId, path),
    upload: (path, file) => endpoints.uploadFile(serviceId, path, file),
    downloadUrl: (path) => endpoints.downloadFileUrl(serviceId, path),
  };
}

function sourceAdapter(serviceId: string): FileAdapter {
  return {
    list: (path) => endpoints.source(serviceId, path),
    read: (path) => endpoints.readSource(serviceId, path),
    // The save publishes; the server queues a deploy off this write.
    write: (path, contents) => endpoints.writeSource(serviceId, path, contents, true),
    makeFolder: (path, name) => endpoints.newSourceFolder(serviceId, path, name),
    rename: (path, name) => endpoints.renameSource(serviceId, path, name),
    remove: (path) => endpoints.deleteSource(serviceId, path),
    upload: (path, file) => endpoints.uploadSource(serviceId, path, file),
    downloadUrl: (path) => endpoints.downloadSourceUrl(serviceId, path),
  };
}

const NO_STORAGE = (
  <p className="rounded-[var(--radius-card)] border border-line border-dashed px-3 py-8 text-center text-[13px] text-ink-faint">
    This app has no storage attached, so there are no files that outlive a deploy. Add some on the
    Storage tab.
  </p>
);

function SiteFiles({ service }: { service: Service }) {
  const adapter = useMemo(() => sourceAdapter(service.id), [service.id]);
  return (
    <FileBrowser
      adapter={adapter}
      publish
      errorPage={(kind) => endpoints.errorPageTemplate(service.id, kind).then((r) => r.contents)}
    />
  );
}

function StorageFiles({ service }: { service: Service }) {
  const adapter = useMemo(() => storageAdapter(service.id), [service.id]);
  return <FileBrowser adapter={adapter} emptyState={NO_STORAGE} />;
}

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
        {view === 'site' ? <SiteFiles service={service} /> : <StorageFiles service={service} />}
      </div>
    );
  }

  return hasSource ? <SiteFiles service={service} /> : <StorageFiles service={service} />;
}
