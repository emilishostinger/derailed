import type { Service, Volume } from '@derailed/shared';
import { AlertTriangle, HardDrive, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

/** Folders people most often need to keep, so nobody has to know Docker conventions. */
const SUGGESTIONS = [
  { path: '/var/www/html/wp-content', label: 'WordPress uploads, themes and plugins' },
  { path: '/app/data', label: 'A general data folder' },
  { path: '/data', label: 'A general data folder' },
  { path: '/app/uploads', label: 'Uploaded files' },
];

export function StorageTab({ service }: { service: Service }) {
  const load = useProjects((s) => s.load);
  const volumes = service.volumes ?? [];
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add(containerPath: string) {
    setBusy(true);
    setError(null);
    try {
      await endpoints.addVolume(service.id, containerPath);
      await load();
      setPath('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {volumes.length === 0 && (
        <div className="flex gap-2.5 rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft px-3.5 py-3">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warn" />
          <div className="min-w-0 text-[13px]">
            <p className="text-ink">Nothing is being kept between deploys.</p>
            <p className="mt-1 text-ink-muted">
              Every deploy starts from a clean copy of your app, so anything it saved is lost:
              uploaded images, installed plugins, files people sent you. Add the folders you want to
              keep below.
            </p>
          </div>
        </div>
      )}

      {volumes.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Kept between deploys</p>
          <div className="space-y-1.5">
            {volumes.map((volume) => (
              <VolumeRow key={volume.id} volume={volume} serviceName={service.name} />
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="eyebrow mb-2">Keep another folder</p>
        <div className="flex gap-2">
          <input
            className="input text-[12px]"
            placeholder="/app/data"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && path.trim() && void add(path.trim())}
          />
          <button
            type="button"
            className="btn-primary shrink-0"
            disabled={busy || !path.trim()}
            onClick={() => void add(path.trim())}
          >
            {busy ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
            Keep it
          </button>
        </div>

        <p className="mt-3 text-[12px] text-ink-faint">Common ones:</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {SUGGESTIONS.filter(
            (suggestion) => !volumes.some((volume) => volume.containerPath === suggestion.path),
          ).map((suggestion) => (
            <button
              key={suggestion.path}
              type="button"
              title={suggestion.label}
              disabled={busy}
              onClick={() => void add(suggestion.path)}
              className={cx(
                'rounded-[var(--radius-control)] border border-line bg-surface-2 px-2 py-1',
                'text-[11px] text-ink-muted transition-colors',
                'hover:border-line-strong hover:text-ink disabled:opacity-50',
              )}
            >
              {suggestion.path}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      </section>

      {volumes.length > 0 && (
        <p className="text-[12px] text-ink-faint">
          New storage is attached the next time you deploy.
        </p>
      )}
    </div>
  );
}

function VolumeRow({ volume, serviceName }: { volume: Volume; serviceName: string }) {
  const load = useProjects((s) => s.load);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <HardDrive className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <code className="min-w-0 flex-1 truncate text-[12px] text-ink">{volume.containerPath}</code>
        <button
          type="button"
          className="btn-ghost px-1.5 text-[12px] text-danger"
          onClick={() => setConfirming((value) => !value)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {confirming && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="text-[12px] text-ink">
            Delete everything {serviceName} has saved in{' '}
            <span className="">{volume.containerPath}</span>? This can't be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn-danger text-[12px]"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await endpoints.deleteVolume(volume.id).catch(() => undefined);
                await load();
              }}
            >
              {busy && <Spinner />}
              Delete it
            </button>
            <button
              type="button"
              className="btn-secondary text-[12px]"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
