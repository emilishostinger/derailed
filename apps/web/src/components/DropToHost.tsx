import { CloudUpload, FolderPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { cx, ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * Drag a zip onto the projects page and it becomes a website.
 *
 * The wizard already accepts a zip, four clicks in, behind a choice about what sort
 * of thing you are making. But the shortest description of this product is "put my
 * folder on the internet", and for that the whole interface should be the window: you
 * drop the thing on it and it asks the one question it cannot guess.
 *
 * It only asks that question when it has to. With no projects yet there is nothing to
 * choose between, so it makes one named after the file and gets on with it.
 */
export function DropToHost() {
  const projects = useProjects((s) => s.projects);
  const load = useProjects((s) => s.load);
  const navigate = useNavigate();

  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  // `dragleave` fires when the pointer crosses into a child, so the overlay would
  // flicker on every element it passed over. Counting enter and leave is the fix.
  const depth = useRef(0);

  useEffect(() => {
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      // Without this the browser navigates away and opens the file instead.
      if (carriesFiles(event)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);

      const dropped = event.dataTransfer?.files?.[0];
      if (!dropped) return;
      if (!dropped.name.toLowerCase().endsWith('.zip')) {
        setRejected(dropped.name);
        return;
      }
      setRejected(null);
      setFile(dropped);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <>
      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-[var(--radius-shell)] border-2 border-dashed border-accent bg-canvas/80 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <CloudUpload className="h-8 w-8 text-accent" />
            <p className="mt-3 text-[15px] font-semibold text-ink">Drop it anywhere</p>
            <p className="mt-1 text-[13px] text-ink-muted">
              A zip of your site goes online in about a minute.
            </p>
          </div>
        </div>
      )}

      {rejected && (
        <Modal title="That needs to be a zip" onClose={() => setRejected(null)}>
          <p className="text-[13px] text-ink">
            <span className="font-medium">{rejected}</span> isn't a .zip file, so there is nothing
            to unpack.
          </p>
          <p className="hint mt-2">
            Right-click the folder your site lives in and compress it, then drop that. Leave out
            node_modules if it has one.
          </p>
          <div className="mt-4 flex justify-end">
            <button type="button" className="btn-primary" onClick={() => setRejected(null)}>
              Right you are
            </button>
          </div>
        </Modal>
      )}

      {file && (
        <PlaceIt
          file={file}
          projects={projects}
          onClose={() => setFile(null)}
          onDone={async (slug) => {
            setFile(null);
            await load();
            navigate(`/p/${slug}`);
          }}
        />
      )}
    </>
  );
}

/** The one question that cannot be guessed: which project this belongs to. */
function PlaceIt({
  file,
  projects,
  onClose,
  onDone,
}: {
  file: File;
  projects: { id: string; name: string; slug: string }[];
  onClose: () => void;
  onDone: (slug: string) => void | Promise<void>;
}) {
  const suggested = file.name.replace(/\.zip$/i, '').replace(/[_\s]+/g, '-');
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function go(projectId: string | null) {
    setBusy(true);
    setError(null);

    // Three calls have to succeed together. If the last one fails, the first two have
    // already happened, and without this you are left with an empty project and a
    // broken app named after a file you never managed to upload. Tidy up behind us,
    // and only remove the project if this is the one that made it.
    let madeProject: string | null = null;
    let madeService: string | null = null;
    try {
      const label = name.trim() || suggested || 'site';
      const project = projectId
        ? projects.find((entry) => entry.id === projectId)!
        : await endpoints.createProject(label);
      if (!projectId) madeProject = project.id;

      const service = await endpoints.createUploadApp(project.id, label);
      madeService = service.id;

      await endpoints.uploadFiles(service.id, file);
      await onDone(project.slug);
    } catch (err) {
      if (madeService) await endpoints.deleteService(madeService).catch(() => undefined);
      if (madeProject) await endpoints.deleteProject(madeProject).catch(() => undefined);
      setError(err);
      setBusy(false);
    }
  }

  // Nothing to choose between yet, so do not pretend there is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once, for the empty case.
  useEffect(() => {
    if (projects.length === 0) void go(null);
  }, []);

  const megabytes = (file.size / 1024 / 1024).toFixed(1);

  return (
    <Modal
      title={projects.length === 0 ? 'Putting it online' : 'Where should it live?'}
      subtitle={`${file.name} · ${megabytes} MB`}
      onClose={busy ? () => undefined : onClose}
    >
      {projects.length === 0 ? (
        <p className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner /> Making a project for it and unpacking the files.
        </p>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="label">Call it</span>
            <input
              className="input"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder={suggested}
            />
          </label>

          <div className="space-y-1.5">
            <p className="eyebrow">Add it to</p>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={busy}
                onClick={() => void go(project.id)}
                className={cx(
                  'flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2',
                  'text-left text-[13px] text-ink transition-colors hover:border-line-strong disabled:opacity-50',
                )}
              >
                {project.name}
              </button>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => void go(null)}
              className={cx(
                'flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-line px-3 py-2',
                'text-left text-[13px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50',
              )}
            >
              <FolderPlus className="h-3.5 w-3.5" />A new project of its own
            </button>
          </div>

          {busy && (
            <p className="flex items-center gap-2 text-[13px] text-ink-muted">
              <Spinner /> Unpacking and starting it.
            </p>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}
