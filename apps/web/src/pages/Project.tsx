import { topics } from '@derailed/shared';
import { MoreHorizontal, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { live } from '../api/ws.ts';
import { NewServiceWizard } from '../components/NewServiceWizard.tsx';
import { useProjectActions } from '../components/projectActions.tsx';
import { ServiceDrawer } from '../components/ServiceDrawer.tsx';
import { TopologyCanvas } from '../components/topology/Canvas.tsx';
import { EmptyState, Spinner } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { NewButton, PageHeader } from './Layout.tsx';

export function ProjectPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projects = useProjects((s) => s.projects);
  const loaded = useProjects((s) => s.loaded);
  const load = useProjects((s) => s.load);
  const [wizardOpen, setWizardOpen] = useState(false);

  const project = projects.find((entry) => entry.slug === slug);

  // The selected service lives in the URL, so the command palette can deep-link
  // straight into a service drawer.
  const selectedId = searchParams.get('service');
  const selectedTab = searchParams.get('tab') ?? undefined;
  const select = (serviceId: string | null, tab?: string) => {
    setSearchParams(
      (params) => {
        if (serviceId) params.set('service', serviceId);
        else params.delete('service');
        if (tab) params.set('tab', tab);
        else params.delete('tab');
        return params;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Before the early returns below, because a hook cannot be called conditionally.
  // Deleting the project you are standing on has to put you somewhere that exists.
  const actions = useProjectActions({
    id: project?.id ?? '',
    name: project?.name ?? '',
    slug: project?.slug ?? '',
    services: project?.services?.length ?? 0,
    onDeleted: () => navigate('/'),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: resubscribing on every project object change would tear down the socket subscription on each live update.
  useEffect(() => {
    if (!project) return;
    return live.subscribe([topics.project(project.id)]);
  }, [project?.id]);

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center text-ink-faint">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (!project) {
    return (
      <EmptyState
        icon={<Workflow className="h-5 w-5" />}
        title="That project is gone"
        body="It may have been deleted from another tab."
        action={
          <Link to="/" className="btn-secondary">
            Back to projects
          </Link>
        }
      />
    );
  }

  const services = project.services ?? [];
  const selected = services.find((service) => service.id === selectedId) ?? null;
  const running = services.filter((service) => service.status === 'running').length;

  return (
    <>
      {actions.element}

      <PageHeader
        title={project.name}
        subtitle={services.length === 0 ? 'Empty' : `${running} of ${services.length} running`}
        actions={
          <>
            <button
              type="button"
              aria-label="Project actions"
              title="Rename, back up or delete"
              className="rounded-[var(--radius-control)] p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={actions.openFrom}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <NewButton label="New" onClick={() => setWizardOpen(true)} />
          </>
        }
      />

      <div className="relative min-h-0 flex-1">
        {services.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-5 w-5" />}
            title="This project is empty"
            body="Paste a GitHub link to put an app online, or add a database first. Whatever you add shows up here as a map of what's running."
            action={
              <button
                type="button"
                className="btn-primary btn-lg"
                onClick={() => setWizardOpen(true)}
              >
                Add something
              </button>
            }
          />
        ) : (
          <TopologyCanvas project={project} selectedId={selectedId} onSelect={select} />
        )}
      </div>

      {wizardOpen && (
        <NewServiceWizard projectId={project.id} onClose={() => setWizardOpen(false)} />
      )}
      {selected && (
        <ServiceDrawer
          key={`${selected.id}:${selectedTab ?? 'overview'}`}
          service={selected}
          initialTab={selectedTab}
          onClose={() => select(null)}
        />
      )}
    </>
  );
}
