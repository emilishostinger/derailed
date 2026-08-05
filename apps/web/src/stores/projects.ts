import type { Deployment, LogLine, Project, Service } from '@derailed/shared';
import { create } from 'zustand';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';

interface Stats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  at: number;
  /** Short history, for the sparklines on the topology canvas. */
  history: number[];
}

interface ProjectsState {
  projects: Project[];
  loaded: boolean;
  error: unknown;
  stats: Record<string, Stats>;
  deployments: Record<string, Deployment>;
  logs: Record<string, LogLine[]>;

  load: () => Promise<void>;
  upsertProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  upsertService: (service: Service) => void;
  removeService: (serviceId: string, projectId: string) => void;
  setServiceStatus: (serviceId: string, status: Service['status']) => void;
  recordStats: (serviceId: string, stats: Omit<Stats, 'at' | 'history'>) => void;
  recordDeployment: (deployment: Deployment) => void;
  appendLogs: (deploymentId: string, lines: LogLine[]) => void;
  setLogs: (deploymentId: string, lines: LogLine[]) => void;

  findService: (serviceId: string) => Service | undefined;
  findProjectBySlug: (slug: string) => Project | undefined;
}

/** The viewer is virtualised, so this is a memory bound rather than a render one. */
const MAX_LOG_LINES = 25_000;
const MAX_HISTORY = 30;

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  loaded: false,
  error: null,
  stats: {},
  deployments: {},
  logs: {},

  async load() {
    try {
      const projects = await endpoints.projects();
      set({ projects, loaded: true, error: null });
    } catch (err) {
      set({ error: err, loaded: true });
    }
  },

  upsertProject(project) {
    set((state) => {
      const index = state.projects.findIndex((entry) => entry.id === project.id);
      if (index < 0) return { projects: [...state.projects, project] };
      const projects = [...state.projects];
      projects[index] = project;
      return { projects };
    });
  },

  removeProject(projectId) {
    set((state) => ({ projects: state.projects.filter((entry) => entry.id !== projectId) }));
  },

  upsertService(service) {
    set((state) => ({
      projects: state.projects.map((project) => {
        if (project.id !== service.projectId) return project;
        const services = project.services ?? [];
        const index = services.findIndex((entry) => entry.id === service.id);
        return {
          ...project,
          services:
            index < 0
              ? [...services, service]
              : services.map((entry) => (entry.id === service.id ? service : entry)),
        };
      }),
    }));
  },

  removeService(serviceId, projectId) {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId
          ? { ...project, services: (project.services ?? []).filter((s) => s.id !== serviceId) }
          : project,
      ),
    }));
  },

  setServiceStatus(serviceId, status) {
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        services: (project.services ?? []).map((service) =>
          service.id === serviceId ? { ...service, status } : service,
        ),
      })),
    }));
  },

  recordStats(serviceId, stats) {
    set((state) => {
      const previous = state.stats[serviceId];
      const history = [...(previous?.history ?? []), stats.cpuPercent].slice(-MAX_HISTORY);
      return { stats: { ...state.stats, [serviceId]: { ...stats, at: Date.now(), history } } };
    });
  },

  recordDeployment(deployment) {
    set((state) => ({ deployments: { ...state.deployments, [deployment.id]: deployment } }));
  },

  appendLogs(deploymentId, lines) {
    set((state) => {
      const existing = state.logs[deploymentId] ?? [];
      const merged = [...existing, ...lines];
      return {
        logs: {
          ...state.logs,
          [deploymentId]: merged.length > MAX_LOG_LINES ? merged.slice(-MAX_LOG_LINES) : merged,
        },
      };
    });
  },

  setLogs(deploymentId, lines) {
    set((state) => ({ logs: { ...state.logs, [deploymentId]: lines } }));
  },

  findService(serviceId) {
    for (const project of get().projects) {
      const service = (project.services ?? []).find((entry) => entry.id === serviceId);
      if (service) return service;
    }
    return undefined;
  },

  findProjectBySlug(slug) {
    return get().projects.find((project) => project.slug === slug);
  },
}));

// The store is hydrated once by REST, then kept live purely by events.
live.on((event) => {
  const store = useProjects.getState();
  switch (event.type) {
    case 'project.updated':
      store.upsertProject(event.project);
      break;
    case 'project.deleted':
      store.removeProject(event.projectId);
      break;
    case 'service.updated':
      store.upsertService(event.service);
      break;
    case 'service.deleted':
      store.removeService(event.serviceId, event.projectId);
      break;
    case 'service.status':
      store.setServiceStatus(event.serviceId, event.status);
      break;
    case 'service.stats':
      store.recordStats(event.serviceId, {
        cpuPercent: event.cpuPercent,
        memoryBytes: event.memoryBytes,
        memoryLimitBytes: event.memoryLimitBytes,
      });
      break;
    case 'deployment.updated':
      store.recordDeployment(event.deployment);
      break;
    case 'deployment.logs':
      store.appendLogs(event.deploymentId, event.lines);
      break;
    default:
      break;
  }
});
