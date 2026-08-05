import type { Service } from '@derailed/shared';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * Shown when an app almost certainly writes data and has nowhere to keep it.
 *
 * A deploy builds a brand-new container, so anything the previous one wrote is gone.
 * For WordPress that means every uploaded image and installed plugin. Nobody should
 * discover that by losing it.
 */
export function StorageWarningBanner({ service }: { service: Service }) {
  const advice = service.storageWarning;
  const load = useProjects((s) => s.load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!advice) return null;

  async function fix() {
    setBusy(true);
    setError(null);
    try {
      for (const path of advice!.paths) {
        await endpoints.addVolume(service.id, path);
      }
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft p-4">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
        Your content would be lost on the next deploy
      </p>
      <p className="mt-1.5 text-[12px] text-ink-muted">
        {advice.what}, and nothing is set to survive a deploy yet. Every deploy starts from a clean
        copy of the app, so uploads, themes and settings would go with it.
      </p>
      <button type="button" className="btn-primary mt-3" disabled={busy} onClick={() => void fix()}>
        {busy && <Spinner />}
        Keep {advice.paths.join(' and ')}
      </button>
      <div className="mt-2">
        <ErrorNote error={error} />
      </div>
    </div>
  );
}

/**
 * The last chance to say so, immediately before a deploy that would do the damage.
 * Deliberately not dismissible-forever: the consequence is permanent.
 */
export function ConfirmRiskyDeploy({
  service,
  onCancel,
  onDeploy,
}: {
  service: Service;
  onCancel: () => void;
  onDeploy: () => void;
}) {
  const advice = service.storageWarning!;
  const load = useProjects((s) => s.load);
  const [busy, setBusy] = useState(false);

  async function fixThenDeploy() {
    setBusy(true);
    for (const path of advice.paths) {
      await endpoints.addVolume(service.id, path).catch(() => undefined);
    }
    await load();
    setBusy(false);
    onDeploy();
  }

  return (
    <Modal title="This will erase what's already there" onClose={onCancel}>
      <div className="space-y-4">
        <p className="text-[13px] text-ink">
          {service.name} has no storage attached, so deploying replaces it with a clean copy.
          Anything saved since the last deploy would be gone: uploaded images, installed themes and
          plugins, and any settings kept in files.
        </p>
        <p className="hint">{advice.what}. Adding storage now keeps it, and takes a second.</p>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" onClick={onDeploy} disabled={busy}>
            Deploy anyway
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void fixThenDeploy()}
            disabled={busy}
          >
            {busy && <Spinner />}
            Keep my content, then deploy
          </button>
        </div>
      </div>
    </Modal>
  );
}
