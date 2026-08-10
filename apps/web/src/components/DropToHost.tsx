import { CloudUpload, Rocket } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { type DroppedFile, readDroppedFolder } from '../lib/dropfiles.ts';
import { useProjects } from '../stores/projects.ts';
import { ErrorNote, Modal, Select, Spinner } from './ui.tsx';

/**
 * Drag a zip anywhere and it becomes a website.
 *
 * The wizard already accepts a zip, four clicks in, behind a choice about what sort
 * of thing you are making. But the shortest description of this product is "put my
 * folder on the internet", and for that the whole interface should be the window: you
 * drop the thing on it and it asks the one question it cannot guess.
 *
 * It only asks that question when it has to. With no projects yet there is nothing to
 * choose between, so it makes one named after the file and gets on with it. And when
 * this is mounted inside a project, standing in that project is the answer: dropping
 * a zip on a page with the project's name at the top of it, and then being asked
 * which project you meant, is the interface not paying attention.
 */
export function DropToHost({ into }: { into?: { id: string; name: string; slug: string } } = {}) {
  const projects = useProjects((s) => s.projects);
  const load = useProjects((s) => s.load);
  const navigate = useNavigate();

  const [dragging, setDragging] = useState(false);
  // Either a zip somebody downloaded, or a folder as it sits on their disk.
  const [drop, setDrop] = useState<Drop | null>(null);
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

      const transfer = event.dataTransfer;
      if (!transfer) return;

      // A folder first, because that is how work actually sits on somebody's disk.
      // "Compress this first" was a step that only ever existed because the software
      // asked for it.
      void readDroppedFolder(transfer).then((folder) => {
        if (folder?.length) {
          setRejected(null);
          setDrop({ kind: 'folder', files: folder });
          return;
        }

        const dropped = transfer.files?.[0];
        if (!dropped) return;
        if (!dropped.name.toLowerCase().endsWith('.zip')) {
          setRejected(dropped.name);
          return;
        }
        setRejected(null);
        setDrop({ kind: 'zip', file: dropped });
      });
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
        <div className="deep-surface pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-[var(--radius-shell)] border-2 border-dashed border-accent bg-canvas/95 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <CloudUpload className="h-8 w-8 text-accent" />
            <p className="mt-3 text-[15px] font-semibold text-ink">
              {into ? `Drop it into ${into.name}` : 'Drop it anywhere'}
            </p>
            <p className="mt-1 text-[13px] text-ink-muted">
              A folder or a zip. Node, Python, PHP, or a folder of HTML.
            </p>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              No Dockerfile needed. node_modules and build folders are skipped.
            </p>
          </div>
        </div>
      )}

      {rejected && (
        <Modal title="Drop a folder, or a zip" onClose={() => setRejected(null)}>
          <p className="text-[13px] text-ink">
            <span className="font-medium">{rejected}</span> is a single file, so there is no project
            in it to build.
          </p>
          <p className="hint mt-2">
            Drag the whole folder your project lives in, or a .zip of it. Anything inside
            node_modules or a build folder is skipped on the way, so you do not have to tidy up
            first.
          </p>
          <div className="mt-4 flex justify-end">
            <button type="button" className="btn-primary" onClick={() => setRejected(null)}>
              Right you are
            </button>
          </div>
        </Modal>
      )}

      {drop && (
        <PlaceIt
          drop={drop}
          // Inside a project there is nothing to choose between, so the list is not
          // offered: `PlaceIt` treats a single known destination as already decided.
          projects={into ? [into] : projects}
          decided={!!into}
          onClose={() => setDrop(null)}
          onDone={async (slug, serviceId) => {
            setDrop(null);
            await load();
            // Straight into the new app's drawer, where the deploy is visibly
            // happening and the address appears the moment it exists.
            navigate(`/p/${slug}?service=${serviceId}`);
          }}
        />
      )}
    </>
  );
}

type Drop = { kind: 'zip'; file: File } | { kind: 'folder'; files: DroppedFile[] };

/** What to call the app: the folder's name, or the zip's without its extension. */
function nameOf(drop: Drop): string {
  if (drop.kind === 'zip') {
    return drop.file.name.replace(/\.zip$/i, '').replace(/[_\s]+/g, '-');
  }
  // Every path is relative to the folder that was dropped, so the folder's own name
  // is not in them. The first segment is only a name when there is a subfolder.
  return 'site';
}

function sizeOf(drop: Drop): number {
  return drop.kind === 'zip'
    ? drop.file.size
    : drop.files.reduce((sum, entry) => sum + entry.file.size, 0);
}

/** The one question that cannot be guessed: which project this belongs to. */
function PlaceIt({
  drop,
  projects,
  decided,
  onClose,
  onDone,
}: {
  drop: Drop;
  projects: { id: string; name: string; slug: string }[];
  /** The destination is already known, so do not ask. */
  decided?: boolean;
  onClose: () => void;
  onDone: (slug: string, serviceId: string) => void | Promise<void>;
}) {
  const suggested = nameOf(drop);
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The destination, chosen from a dropdown so a long list of projects stays one
  // control rather than a wall of buttons. A sentinel value means "a new project".
  const NEW_PROJECT = '__new__';
  const [dest, setDest] = useState<string>(NEW_PROJECT);

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

      await (drop.kind === 'folder'
        ? endpoints.uploadFolder(service.id, drop.files)
        : endpoints.uploadFiles(service.id, drop.file));
      await onDone(project.slug, service.id);
    } catch (err) {
      if (madeService) await endpoints.deleteService(madeService).catch(() => undefined);
      if (madeProject) await endpoints.deleteProject(madeProject).catch(() => undefined);
      setError(err);
      setBusy(false);
    }
  }

  // Nothing to choose between, so do not pretend there is: either there are no
  // projects yet, or we are standing inside the one it belongs to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once, for the settled cases.
  useEffect(() => {
    if (decided) void go(projects[0]!.id);
    else if (projects.length === 0) void go(null);
  }, []);

  const settled = decided || projects.length === 0;
  const megabytes = (sizeOf(drop) / 1024 / 1024).toFixed(1);

  return (
    <Modal
      title={settled ? 'Putting it online' : 'Where should it live?'}
      subtitle={
        drop.kind === 'folder'
          ? `${suggested} · ${drop.files.length} files · ${megabytes} MB`
          : `${drop.file.name} · ${megabytes} MB`
      }
      onClose={busy ? () => undefined : onClose}
    >
      {settled ? (
        <div className="space-y-2">
          {busy && (
            <p className="flex items-center gap-2 text-[13px] text-ink-muted">
              <Spinner />
              {decided
                ? 'Unpacking the files and starting it.'
                : 'Making a project for it and unpacking the files.'}
            </p>
          )}
          <ErrorNote error={error} />
        </div>
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

          <label className="block">
            <span className="label">Add it to</span>
            {/* A dropdown, not a stack of buttons: one project or a hundred, this
                stays one control that scrolls and takes typeahead. */}
            <Select
              ariaLabel="Which project to add it to"
              value={dest}
              disabled={busy}
              onChange={setDest}
              options={[
                { value: NEW_PROJECT, label: 'A new project of its own' },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
          </label>

          <div className="flex items-center justify-end gap-3">
            {busy && (
              <p className="flex items-center gap-2 text-[13px] text-ink-muted">
                <Spinner /> Unpacking and starting it.
              </p>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void go(dest === NEW_PROJECT ? null : dest)}
            >
              <Rocket className="h-3.5 w-3.5" />
              Put it online
            </button>
          </div>
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}
