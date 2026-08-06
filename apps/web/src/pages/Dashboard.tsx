import type { Project } from '@derailed/shared';
import {
  Archive,
  Boxes,
  ChevronRight,
  Container,
  Database,
  Globe,
  Layers,
  Lock,
  Server,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OtherSoftware } from '../api/endpoints.ts';
import { endpoints } from '../api/endpoints.ts';
import { cx, EmptyState, ErrorNote, Field, Modal, Spinner, StatusDot } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { NewButton, PageHeader } from './Layout.tsx';

export function Dashboard() {
  const projects = useProjects((s) => s.projects);
  const loaded = useProjects((s) => s.loaded);
  const load = useProjects((s) => s.load);
  const system = useSession((s) => s.system);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={projects.length > 0 ? `${projects.length}` : undefined}
        actions={
          projects.length > 0 && <NewButton label="New project" onClick={() => setCreating(true)} />
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded && (
          <div className="flex justify-center py-20 text-ink-faint">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {loaded && projects.length === 0 && (
          <EmptyState
            icon={<Layers className="h-5 w-5" />}
            title={system?.dockerOk ? 'Nothing running yet' : "Docker isn't reachable"}
            body={
              system?.dockerOk
                ? 'A project groups things that belong together, your app and its database. Create one, then paste a GitHub link.'
                : "Derailed can't talk to Docker, so it can't run anything. Check that the Docker service is started on this server."
            }
            action={
              <button
                type="button"
                className="btn-primary btn-lg"
                disabled={!system?.dockerOk}
                onClick={() => setCreating(true)}
              >
                Create your first project
              </button>
            }
          />
        )}

        {loaded && projects.length > 0 && (
          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}

        {loaded && <AlsoHere />}
      </div>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}

/**
 * Derailed is a thing running on this server too, and so is whatever was here before
 * it. A dashboard that shows only what it created is a view of itself, not of the
 * machine, and "what is actually on my server" is the first question anyone asks.
 */
function AlsoHere() {
  const [others, setOthers] = useState<OtherSoftware | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    endpoints
      .others()
      .then(setOthers)
      .catch(() => undefined);
  }, []);

  if (!others) return null;
  const extra = others.containers;

  return (
    <div className="px-5 pb-5">
      <button
        type="button"
        className="eyebrow flex items-center gap-1.5 py-2 text-ink-faint transition-colors hover:text-ink-muted"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cx('h-3 w-3 transition-transform', open && 'rotate-90')} />
        Also on this server
        {extra.length > 0 && <span className="text-ink-faint">({extra.length + 1})</span>}
      </button>

      {open && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="card flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                Derailed
              </span>
              <span className="shrink-0 text-[11px] text-ink-faint tabular">
                v{others.derailed.version}
              </span>
            </div>
            <p className="text-[12px] text-ink-muted">
              This dashboard. It runs on the server itself rather than in a container, so it keeps
              working even when Docker does not.
            </p>
            <p className="mt-auto truncate border-t border-line pt-2.5 text-[11px] text-ink-faint">
              {others.derailed.dataDir}
            </p>
          </div>

          {extra.map((container) => (
            <div key={container.id} className="card flex flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <Container className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                  {container.name}
                </span>
                <StatusDot status={container.state === 'running' ? 'running' : 'stopped'} />
              </div>
              <p className="truncate text-[12px] text-ink-muted">{container.image}</p>
              <p className="mt-auto flex flex-wrap gap-x-3 border-t border-line pt-2.5 text-[11px] text-ink-faint">
                <span>{container.status}</span>
                {container.ports.map((port) => (
                  <span key={port} className="tabular">
                    {port}
                  </span>
                ))}
              </p>
            </div>
          ))}
        </div>
      )}

      {open && (
        <p className="pt-3 text-[12px] text-ink-faint">
          {extra.length === 0
            ? 'Nothing else is running here. Anything you start outside Derailed shows up in this list.'
            : 'Derailed did not start these, so it leaves them alone. They are here so the list matches what is really on the machine.'}
        </p>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const services = project.services ?? [];
  const apps = services.filter((service) => service.kind === 'app');
  const databases = services.filter((service) => service.kind === 'database');
  // Someone who has attached their own domain thinks of the project by that name,
  // not by the throwaway address Derailed handed out.
  const allDomains = apps.flatMap((app) => app.domains ?? []);
  const address =
    allDomains.find((domain) => domain.kind === 'custom') ??
    allDomains.find((domain) => domain.tlsStatus === 'active') ??
    allDomains[0];
  const secure = address?.tlsStatus === 'active';

  return (
    <Link
      to={`/p/${project.slug}`}
      className="card group flex flex-col gap-3 p-4 transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-surface-2/40"
    >
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 shrink-0 text-ink-faint" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {project.name}
        </h2>
        {services.length > 0 && <StatusCounts services={services} />}
      </div>

      {address ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-accent">
          {secure ? (
            <Lock className="h-3 w-3 shrink-0 text-ok" />
          ) : (
            <Globe className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{address.hostname}</span>
        </p>
      ) : (
        <p className="text-[12px] text-ink-faint">No web address yet</p>
      )}

      <div className="mt-auto flex items-center gap-3 border-t border-line pt-3 text-[12px] text-ink-muted">
        {services.length === 0 ? (
          <span className="text-ink-faint">Empty, add an app or a database</span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <Layers className="h-3 w-3 text-ink-faint" />
              {apps.length} app{apps.length === 1 ? '' : 's'}
            </span>
            {databases.length > 0 && (
              <span className="flex items-center gap-1.5">
                <Database className="h-3 w-3 text-ink-faint" />
                {databases.length}
              </span>
            )}
            {/* Said either way. "No backups" is the more useful of the two to notice. */}
            <span
              className={cx(
                'ml-auto flex items-center gap-1.5',
                project.backupSchedule === 'off' ? 'text-ink-faint' : 'text-ok',
              )}
            >
              <Archive className="h-3 w-3" />
              {project.backupSchedule === 'daily'
                ? 'Daily backups'
                : project.backupSchedule === 'weekly'
                  ? 'Weekly backups'
                  : 'No backups'}
            </span>
          </>
        )}
      </div>
    </Link>
  );
}

/**
 * Overlapping dots were unreadable once there were more than two, and said nothing
 * about how many of each. One chip per state that actually occurs, in a fixed order
 * so the eye can find "the red one" in the same place every time.
 */
function StatusCounts({ services }: { services: { status?: string | null }[] }) {
  const ORDER = ['failed', 'crashed', 'deploying', 'creating', 'running', 'stopped'];
  const counts = new Map<string, number>();
  for (const service of services) {
    const status = service.status ?? 'stopped';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {ORDER.filter((status) => counts.has(status)).map((status) => (
        <span key={status} className="flex items-center gap-1 text-[11px] text-ink-muted tabular">
          <StatusDot status={status} />
          {counts.get(status)}
        </span>
      ))}
    </div>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const load = useProjects((s) => s.load);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.createProject(name.trim());
      await load();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title="New project" subtitle="Name it after what you're building." onClose={onClose}>
      <div className="space-y-4">
        <Field label="Project name">
          <input
            className="input"
            value={name}
            placeholder="My side project"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
          />
        </Field>

        <ErrorNote error={error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            {busy && <Spinner />}
            Create project
          </button>
        </div>
      </div>
    </Modal>
  );
}
