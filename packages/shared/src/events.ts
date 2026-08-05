/**
 * WebSocket protocol.
 *
 * The client subscribes to topics; the server pushes whole updated entities so the
 * client never has to reconcile partial state. Log lines are batched by the server.
 */
import type {
  Deployment,
  DeploymentStatus,
  Domain,
  LogLine,
  Project,
  Service,
  ServiceStatus,
  SystemInfo,
} from './types.ts';

/** `system` | `project:<id>` | `service:<id>` | `deployment:<id>` */
export type Topic = string;

export const topics = {
  system: 'system',
  project: (id: string): Topic => `project:${id}`,
  service: (id: string): Topic => `service:${id}`,
  deployment: (id: string): Topic => `deployment:${id}`,
};

export type ClientMessage =
  | { type: 'subscribe'; topics: Topic[] }
  | { type: 'unsubscribe'; topics: Topic[] }
  | { type: 'ping' };

export type ServerEvent =
  | { type: 'hello'; version: string }
  | { type: 'pong' }
  | { type: 'system'; system: SystemInfo }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'service.updated'; service: Service }
  | { type: 'service.deleted'; serviceId: string; projectId: string }
  | { type: 'service.status'; serviceId: string; status: ServiceStatus }
  | {
      type: 'service.stats';
      serviceId: string;
      cpuPercent: number;
      memoryBytes: number;
      memoryLimitBytes: number;
    }
  | { type: 'deployment.updated'; deployment: Deployment }
  | {
      type: 'deployment.status';
      deploymentId: string;
      serviceId: string;
      status: DeploymentStatus;
    }
  | { type: 'deployment.logs'; deploymentId: string; lines: LogLine[] }
  | { type: 'service.logs'; serviceId: string; lines: LogLine[] }
  | { type: 'domain.updated'; domain: Domain };

export type ServerEventType = ServerEvent['type'];
