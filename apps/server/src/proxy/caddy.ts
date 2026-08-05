import { caddy as caddyConfig, isDev, paths } from '../config.ts';
import {
  connectToNetwork,
  createContainer,
  destroyContainer,
  findContainerByName,
  inspectContainer,
  startContainer,
} from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { managedLabels } from '../docker/labels.ts';
import { ensureNetwork } from '../docker/networks.ts';
import { ensureVolume } from '../docker/volumes.ts';
import { setCaddyHealthy } from '../system/status.ts';
import { type CaddyConfig, type RouteSpec, synthesizeCaddyConfig } from './routes.ts';

const ADMIN_ORIGIN = `http://127.0.0.1:${caddyConfig.adminPort}`;

/** Resolvable inside Caddy's container thanks to the host-gateway mapping below. */
export const HOST_GATEWAY = 'host.docker.internal';

/** Inside the container Caddy always uses the standard ports; the host mapping varies. */
const INTERNAL_HTTP = 80;
const INTERNAL_HTTPS = 443;

export class CaddyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaddyUnavailable';
  }
}

/**
 * Makes sure the managed Caddy container exists and is running. Safe to call at
 * every boot: an existing healthy container is adopted, a stopped one restarted,
 * and a container built from an outdated spec replaced.
 */
export async function ensureCaddyRunning(onLog?: (line: string) => void): Promise<void> {
  await ensureNetwork(caddyConfig.network, managedLabels({ role: 'proxy' }));
  await ensureVolume(caddyConfig.dataVolume, managedLabels({ role: 'proxy' }));
  await ensureVolume(`${caddyConfig.dataVolume}-config`, managedLabels({ role: 'proxy' }));

  const existing = await findContainerByName(caddyConfig.containerName);
  if (existing) {
    // A container made by an older Derailed is missing the folder the access log is
    // written to, so the traffic figures would stay empty forever with nothing saying
    // why. Replacing it costs a couple of seconds of downtime, once.
    if (await missingLogMount(existing.Id)) {
      onLog?.('Replacing the web traffic router so it can record visits…');
      await destroyContainer(existing.Id, 5);
    } else if (existing.State === 'running') {
      setCaddyHealthy(await pingCaddy());
      return;
    } else {
      onLog?.('Restarting the web traffic router…');
      await startContainer(existing.Id);
      setCaddyHealthy(await waitForCaddy());
      return;
    }
  }

  if (!(await imageExists(caddyConfig.image))) {
    onLog?.(`Downloading ${caddyConfig.image}…`);
    await pullImage(caddyConfig.image, onLog);
  }

  onLog?.('Starting the web traffic router…');
  const id = await createContainer({
    name: caddyConfig.containerName,
    image: caddyConfig.image,
    // `--resume` reloads the config Caddy autosaved, so a restart keeps serving.
    cmd: ['caddy', 'run', '--resume'],
    env: { CADDY_ADMIN: `0.0.0.0:${caddyConfig.adminPort}` },
    labels: managedLabels({ role: 'proxy' }),
    network: caddyConfig.network,
    ports: {
      [INTERNAL_HTTP]: { host: '0.0.0.0', port: caddyConfig.httpPort },
      [INTERNAL_HTTPS]: { host: '0.0.0.0', port: caddyConfig.httpsPort },
      // Admin API stays on loopback, only the Derailed process talks to it.
      [caddyConfig.adminPort]: { host: '127.0.0.1', port: caddyConfig.adminPort },
    },
    volumes: {
      [caddyConfig.dataVolume]: '/data',
      [`${caddyConfig.dataVolume}-config`]: '/config',
      // A host folder, so Derailed can read the access log without going through
      // Docker. It is the only source of the traffic figures.
      [paths.accessLogs]: '/logs',
    },
    // The dashboard runs on the host, not in a container, so putting it behind a
    // domain means Caddy has to be able to reach back out to the host.
    extraHosts: [`${HOST_GATEWAY}:host-gateway`],
    restartPolicy: 'unless-stopped',
  });
  await startContainer(id);
  setCaddyHealthy(await waitForCaddy());
}

/** Whether this container predates the access log folder being mounted in. */
async function missingLogMount(id: string): Promise<boolean> {
  const inspected = await inspectContainer(id).catch(() => null);
  if (!inspected) return false;
  const mounts = (inspected as unknown as { Mounts?: { Destination?: string }[] }).Mounts ?? [];
  return !mounts.some((mount) => mount.Destination === '/logs');
}

export async function removeCaddy(): Promise<void> {
  const existing = await findContainerByName(caddyConfig.containerName);
  if (existing) await destroyContainer(existing.Id, 5);
  setCaddyHealthy(false);
}

/** Caddy needs to be on a project's network to reach that project's containers. */
export async function attachCaddyToNetwork(network: string): Promise<void> {
  const existing = await findContainerByName(caddyConfig.containerName);
  if (!existing) return;
  await connectToNetwork(existing.Id, network);
}

export async function pingCaddy(): Promise<boolean> {
  try {
    const response = await fetch(`${ADMIN_ORIGIN}/config/`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCaddy(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingCaddy()) return true;
    await Bun.sleep(400);
  }
  return false;
}

/** Replaces Caddy's entire configuration. */
export async function pushCaddyConfig(config: CaddyConfig): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${ADMIN_ORIGIN}/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    setCaddyHealthy(false);
    throw new CaddyUnavailable(
      "Derailed couldn't reach the web traffic router, so your web addresses weren't updated.",
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    setCaddyHealthy(false);
    throw new CaddyUnavailable(`The web traffic router rejected the update. ${detail}`.trim());
  }
  setCaddyHealthy(true);
}

export function buildCaddyConfig(routes: RouteSpec[]): CaddyConfig {
  return synthesizeCaddyConfig(routes, {
    // Container-internal ports; the host mapping is set when the container is created.
    httpPort: INTERNAL_HTTP,
    httpsPort: INTERNAL_HTTPS,
    adminListen: `0.0.0.0:${caddyConfig.adminPort}`,
  });
}

/** The port a visitor actually types (dev uses high ports to avoid needing root). */
export function publicPortSuffix(https: boolean): string {
  if (!isDev) return '';
  return https ? `:${caddyConfig.httpsPort}` : `:${caddyConfig.httpPort}`;
}
