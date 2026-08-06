import type { AdoptablePort } from '@derailed/shared';
import { createProject, findProjectBySlug } from '../db/repo/projects.ts';
import { createAppService } from '../db/repo/services.ts';
import { inspectContainer, listContainers } from '../docker/containers.ts';
import { isManaged } from '../docker/labels.ts';

/**
 * Taking over something already running on this machine.
 *
 * Derailed's install is deliberately safe on a busy server: it only ever touches what
 * it created, and everything else is listed as "other things on this server" and
 * otherwise ignored. That is the right default and a dead end, because the common
 * case is somebody who already runs three things with `docker run` and would like
 * HTTPS and backups for them without starting again.
 *
 * Adopting is deliberately shallow. Derailed records the container as an app it can
 * route to, and does not take ownership of how it was built or how it starts. It was
 * put there by hand and it keeps working exactly as it did; what it gains is an
 * address, a certificate, the uptime check and a place in the topology.
 */

export interface Adoptable {
  id: string;
  name: string;
  image: string;
  state: string;
  /** Ports it publishes, which is how a web address can be pointed at it. */
  ports: AdoptablePort[];
  /** The port Derailed would use, when there is an obvious one. */
  suggestedPort: number | null;
  /** Why this one cannot be adopted, when it cannot. */
  blocked: string | null;
}

/** Ports that are almost never the web. */
const UNLIKELY = new Set([22, 3306, 5432, 6379, 27017, 25, 587, 465, 11211, 2375, 2376]);

/**
 * Which port to point a web address at.
 *
 * A guess, and a conservative one: the familiar web ports first, then anything that
 * is not obviously a database, then nothing. Suggesting 5432 for a Postgres container
 * would produce an address that answers with binary nonsense, which is a worse first
 * impression than an empty field.
 */
export function suggestPort(ports: AdoptablePort[]): number | null {
  if (!ports.length) return null;
  // The web ports first, then anything else that is not obviously a database.
  const web = ports.find((port) => [80, 8080, 3000, 8000, 5000].includes(port.container));
  if (web) return web.container;
  const plausible = ports.find((port) => !UNLIKELY.has(port.container));
  return plausible?.container ?? null;
}

/** Everything on this machine that Derailed did not create and could take over. */
export async function adoptable(): Promise<Adoptable[]> {
  const containers = await listContainers('', true).catch(() => []);

  return containers
    .filter((container) => !isManaged(container.Labels))
    .map((container) => {
      // Deduplicated: Docker reports one entry per binding, so a container published
      // on both IPv4 and IPv6 appears as the same port twice, which reads as a mistake.
      const seen = new Set<number>();
      const ports: AdoptablePort[] = (container.Ports ?? [])
        .filter((port) => port.Type === 'tcp')
        .filter((port) => {
          if (seen.has(port.PrivatePort)) return false;
          seen.add(port.PrivatePort);
          return true;
        })
        .map((port) => ({ container: port.PrivatePort, published: port.PublicPort ?? null }));

      const name = (container.Names?.[0] ?? '').replace(/^\//, '') || container.Id.slice(0, 12);
      const suggestedPort = suggestPort(ports);

      return {
        id: container.Id,
        name,
        image: container.Image,
        state: container.State,
        ports,
        suggestedPort,
        blocked:
          container.State !== 'running'
            ? 'It is not running, so there is nothing to point an address at yet.'
            : ports.length === 0
              ? 'It does not listen on any port, so nothing can be routed to it.'
              : null,
      };
    })
    .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || a.name.localeCompare(b.name));
}

export class AdoptError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'AdoptError';
    this.hint = hint;
  }
}

/**
 * Records an existing container as an app.
 *
 * Nothing is restarted, relabelled or rebuilt. The container is left exactly as it
 * was found, which is the whole promise of Derailed on a machine that was already
 * doing something: it does not take over, it joins in.
 *
 * The consequence, said plainly on the screen: Derailed cannot redeploy it. It knows
 * how to route to it, watch it and back up what it names, and that is all.
 */
export async function adopt(
  containerId: string,
  options: { projectName?: string; appName?: string; port?: number },
): Promise<{ projectId: string; serviceId: string }> {
  const inspected = (await inspectContainer(containerId).catch(() => null)) as {
    Name?: string;
    State?: { Running?: boolean };
    Config?: { Image?: string };
    NetworkSettings?: { Networks?: Record<string, unknown> };
  } | null;

  if (!inspected) throw new AdoptError('That container is no longer here.');
  if (!inspected.State?.Running) {
    throw new AdoptError(
      'That container is not running.',
      'Start it first, so Derailed can check what it answers on.',
    );
  }

  const name = (inspected.Name ?? '').replace(/^\//, '') || containerId.slice(0, 12);
  const projectName = options.projectName?.trim() || 'Adopted';

  const project =
    findProjectBySlug(projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')) ??
    createProject(projectName);

  const service = createAppService({
    projectId: project.id,
    name: options.appName?.trim() || name,
    // Recorded as an image, which is what it is. Derailed will not try to build it.
    source: 'image',
    image: inspected.Config?.Image ?? 'unknown',
    repoUrl: null,
    branch: null,
    port: options.port ?? null,
  });

  return { projectId: project.id, serviceId: service.id };
}
