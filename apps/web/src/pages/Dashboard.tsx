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
  MoreHorizontal,
  Server,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OtherSoftware } from '../api/endpoints.ts';
import { endpoints } from '../api/endpoints.ts';
import { CostCounter } from '../components/CostCounter.tsx';
import { DropToHost } from '../components/DropToHost.tsx';
import { GettingStarted } from '../components/GettingStarted.tsx';
import { useProjectActions } from '../components/projectActions.tsx';
import { ProjectPreview } from '../components/SitePreview.tsx';
import {
  cx,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  Reveal,
  Spinner,
  StatusDot,
} from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { useToasts } from '../stores/toasts.ts';
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
      {/* The whole page is a drop target. This is the shortest path there is from a
          folder on your computer to a website, so it should not be behind a wizard. */}
      <DropToHost />

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

        {/* Above the projects, and only until it is done with. This is the one place
            someone on their first day will actually look. */}
        {loaded && (
          <div className="px-5 pt-5">
            <GettingStarted />
          </div>
        )}

        {loaded && projects.length > 0 && (
          <>
            <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
            {/* Below the projects rather than above: it is a nice thing to notice on
                the way past, not the headline. */}
            <div className="px-5 pb-5">
              <CostCounter />
            </div>
          </>
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

      <Reveal open={open}>
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
              <p className="flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
                <span>{container.status}</span>
                {container.ports.map((port) => (
                  <span key={port} className="tabular">
                    {port}
                  </span>
                ))}
              </p>
              {/* Derailed did not start it and will not take it over, but it can give
                  it an address, a certificate and a place in the topology. */}
              <div className="mt-auto border-t border-line pt-2.5">
                <AdoptButton id={container.id} name={container.name} />
              </div>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal open={open}>
        <p className="pt-3 text-[12px] text-ink-faint">
          {extra.length === 0
            ? 'Nothing else is running here. Anything you start outside Derailed shows up in this list.'
            : 'Derailed did not start these and leaves them alone. Take one over and it keeps running exactly as it is, but gains a web address, a certificate and a place in the map.'}
        </p>
      </Reveal>
    </div>
  );
}

/**
 * Taking over something already running.
 *
 * Shallow on purpose: the container is untouched and simply becomes something
 * Derailed can route to and watch. It says what it cannot do, because "why will it
 * not redeploy?" is the obvious next question.
 */
function AdoptButton({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);

  if (done) return <p className="text-[11px] text-ok">Taken over. It is in Adopted.</p>;

  return (
    <button
      type="button"
      className="btn-ghost !px-0 text-[12px]"
      disabled={busy}
      onClick={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const { containers } = { containers: await endpoints.adoptable() };
          const match = containers.find((entry) => entry.id === id);
          await endpoints.adopt({
            containerId: id,
            appName: name,
            port: match?.suggestedPort ?? undefined,
          });
          await load();
          setDone(true);
          push({
            message: `${name} is now in Derailed. It keeps running as it is; give it an address on its Domains tab.`,
            tone: 'ok',
          });
        } catch {
          push({ message: `${name} could not be taken over.`, tone: 'danger' });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Taking it over…' : 'Take it over'}
    </button>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const services = project.services ?? [];
  const actions = useProjectActions({
    id: project.id,
    name: project.name,
    slug: project.slug,
    services: services.length,
  });
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
    <>
      <Link
        to={`/p/${project.slug}`}
        onContextMenu={actions.onContextMenu}
        className={cx(
          'card group relative flex flex-col gap-3 p-4 transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-surface-2/40',
          actions.isOpen && 'border-line-strong bg-surface-2/40',
        )}
      >
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 shrink-0 text-ink-faint" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {project.name}
          </h2>
          {services.length > 0 && <StatusCounts services={services} />}
          {/* Quiet until the card is under the pointer, then the way in to renaming and
              deleting. Inside the link, so its click must not follow it. */}
          <button
            type="button"
            aria-label={`Actions for ${project.name}`}
            className={cx(
              '-mr-1 shrink-0 rounded-[4px] p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100',
              actions.isOpen && 'text-ink opacity-100',
            )}
            onClick={(event) => {
              event.preventDefault();
              actions.openFrom(event);
            }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>

        <ProjectPreview services={apps} />

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

      {/* Outside the link on purpose. React events cross portals by the component
          tree, so a menu rendered inside the card would follow it on every click. */}
      {actions.element}
    </>
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
