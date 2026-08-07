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
  | { type: 'domain.updated'; domain: Domain }
  /**
   * How far along claiming the free address is.
   *
   * It is the one thing in Derailed that routinely takes minutes: a certificate tool
   * to fetch, a DNS record to propagate, and Let's Encrypt to answer. A spinner for
   * three minutes is indistinguishable from a spinner for something that has hung,
   * and the second one is what people assume.
   */
  | {
      type: 'freedomain.progress';
      step: FreeDomainStep;
      /** What is happening, in the words the screen should use. */
      message: string;
      /** The tool's own output, for the line underneath. Often absent. */
      detail?: string;
    }
  /** A fresh title, icon or screenshot is available for this app. */
  | { type: 'preview'; serviceId: string };

/** The stages of claiming a free address, in the order they happen. */
export type FreeDomainStep = 'point' | 'tool' | 'certificate' | 'addresses' | 'done';

export const FREE_DOMAIN_STEPS: { step: FreeDomainStep; label: string }[] = [
  { step: 'point', label: 'Pointing the name at this server' },
  { step: 'tool', label: 'Getting the certificate tool' },
  { step: 'certificate', label: "Asking Let's Encrypt" },
  { step: 'addresses', label: 'Giving your apps their new addresses' },
];

export type ServerEventType = ServerEvent['type'];
