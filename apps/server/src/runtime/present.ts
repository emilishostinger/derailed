import type { Deployment, Project, Service, ServiceStatus } from '@derailed/shared';
import { ACTIVE_DEPLOYMENT_STATUSES, topics } from '@derailed/shared';
import { storageAdviceFor } from '../catalog/templates.ts';
import { latestDeployment, runningDeployment } from '../db/repo/deployments.ts';
import { listDomains } from '../db/repo/domains.ts';
import { listLinks } from '../db/repo/links.ts';
import { listProjects } from '../db/repo/projects.ts';
import { findService, listServices, repoToken } from '../db/repo/services.ts';
import { listVolumesFor } from '../db/repo/volumes.ts';
import { publishAll } from '../events/bus.ts';
import { liveStatus } from './livestatus.ts';

/**
 * Everything the API and the WebSocket hand to the browser goes through here, so a
 * service looks the same whether it arrived from a REST call or a live event.
 */
export function serviceStatus(service: Service): ServiceStatus {
  // A database is just a container. It has no deployments to reason about, so its
  // status comes from what Docker last told us. Until the container exists we're
  // genuinely still setting it up.
  if (service.kind === 'database') {
    if (service.instancesDesired === 0) return 'stopped';
    return liveStatus(service.id) ?? 'creating';
  }

  const latest = latestDeployment(service.id);
  if (!latest) return 'stopped';

  if (ACTIVE_DEPLOYMENT_STATUSES.includes(latest.status)) return 'deploying';
  if (service.instancesDesired === 0) return 'stopped';

  switch (latest.status) {
    case 'running':
      return 'running';
    case 'failed':
      // A failed deploy on top of a working one: the old version is still serving.
      return runningDeployment(service.id) ? 'running' : 'failed';
    case 'canceled':
    case 'superseded':
      return runningDeployment(service.id) ? 'running' : 'stopped';
    default:
      return 'stopped';
  }
}

export function presentService(service: Service): Service {
  return {
    ...service,
    status: serviceStatus(service),
    latestDeployment: latestDeployment(service.id),
    domains: listDomains(service.id),
    volumes: listVolumesFor(service.id),
    storageWarning:
      service.kind === 'app' && listVolumesFor(service.id).length === 0
        ? storageAdviceFor(service.image, service.framework, service.name)
        : null,
    hasRepoToken: !!repoToken(service.id),
  };
}

export function presentProject(project: Project): Project {
  return {
    ...project,
    services: listServices(project.id).map(presentService),
    links: listLinks(project.id),
  };
}

export function presentProjects(): Project[] {
  return listProjects().map(presentProject);
}

/** Broadcasts a service to everyone watching it or its project. */
export function emitService(serviceId: string): Service | null {
  const service = findService(serviceId);
  if (!service) return null;
  const presented = presentService(service);
  publishAll([topics.service(serviceId), topics.project(service.projectId)], {
    type: 'service.updated',
    service: presented,
  });
  return presented;
}

export function emitProject(projectId: string): void {
  const project = listProjects().find((entry) => entry.id === projectId);
  if (!project) return;
  publishAll([topics.project(projectId), topics.system], {
    type: 'project.updated',
    project: presentProject(project),
  });
}

export type { Deployment };
