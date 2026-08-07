import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Modal, Spinner } from './ui.tsx';

/**
 * A ceiling for everything in a project.
 *
 * A memory limit already existed per app, and had to be set per app, which means it
 * got set on the app somebody was already worried about and on none of the others.
 * The app that takes a box down is by definition the one nobody expected.
 *
 * Applied to each container rather than shared out between them. A quota divided
 * among apps changes every time one is added, and the thing this is for is one
 * runaway process: capping each container caps the damage, and the number on this
 * screen still means the same thing next month.
 */
export function ProjectLimits({
  id,
  name,
  onClose,
}: {
  id: string;
  name: string;
  onClose: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);
  const project = projects.find((entry) => entry.id === id);

  const [memory, setMemory] = useState('');
  const [cpu, setCpu] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setMemory(project?.memoryLimitMb ? String(project.memoryLimitMb) : '');
    // Shown in cores, stored in thousandths: nobody thinks in millicores, and
    // "0.5" is what a person means by half a core.
    setCpu(project?.cpuLimitMillis ? String(project.cpuLimitMillis / 1000) : '');
  }, [project?.memoryLimitMb, project?.cpuLimitMillis]);

  const save = () => {
    setBusy(true);
    setError(null);

    const cores = Number(cpu.trim());
    endpoints
      .setProjectLimits(id, {
        memoryLimitMb: memory.trim() ? Number(memory.trim()) : null,
        cpuLimitMillis: cpu.trim() && Number.isFinite(cores) ? Math.round(cores * 1000) : null,
      })
      .then(() => {
        push({ message: 'Saved. Each app picks it up on its next deploy.', tone: 'ok' });
        void load();
        onClose();
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title="Limits"
      subtitle={`A ceiling for every app in ${name}. Leave either empty for no limit.`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field
          label="Memory, per app"
          hint="In megabytes. An app that goes past this is stopped rather than taking the server with it. At least 64."
        >
          <input
            className="input"
            inputMode="numeric"
            value={memory}
            placeholder="512"
            onChange={(event) => setMemory(event.target.value)}
          />
        </Field>
        <Field
          label="Processor, per app"
          hint="In cores. 0.5 is half a core. A limit rather than a share, so a runaway loop is throttled whether or not anything else wants the processor."
        >
          <input
            className="input"
            inputMode="decimal"
            value={cpu}
            placeholder="1"
            onChange={(event) => setCpu(event.target.value)}
          />
        </Field>

        <p className="text-[12px] text-ink-faint">
          Each applies to every app in the project on its own, not shared between them. An app with
          its own memory limit keeps it: a number you typed there was meant.
        </p>

        <ErrorNote error={error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={save}>
            {busy && <Spinner />}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
