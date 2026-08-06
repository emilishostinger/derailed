import {
  CADDY_ADMIN_DIR_IN_CONTAINER,
  caddyAdminOverSocket,
  caddyAdminSocket,
  caddy as caddyConfig,
  ensureDirs,
  isDev,
  paths,
} from '../config.ts';
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
import { ensureVolume, removeVolume } from '../docker/volumes.ts';
import { setCaddyHealthy } from '../system/status.ts';
import { type CaddyConfig, type RouteSpec, synthesizeCaddyConfig } from './routes.ts';

/**
 * Where Caddy's admin API listens, from Caddy's own point of view. A unix socket has
 * no port and no address, which is the entire point: see `caddyAdminOverSocket`.
 */
export const caddyAdminListen = caddyAdminOverSocket
  ? `unix/${CADDY_ADMIN_DIR_IN_CONTAINER}/admin.sock`
  : `0.0.0.0:${caddyConfig.adminPort}`;

const ADMIN_ORIGIN = `http://127.0.0.1:${caddyConfig.adminPort}`;

/** `fetch` options that reach the admin API, over the socket where there is one. */
function adminRequest(path: string, init: RequestInit = {}): [string, RequestInit] {
  if (!caddyAdminOverSocket) return [`${ADMIN_ORIGIN}${path}`, init];
  // The host is ignored for a unix socket, but `fetch` still insists on a valid URL.
  return [`http://caddy-admin${path}`, { ...init, unix: caddyAdminSocket } as RequestInit];
}

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
  // The socket lands in a folder Derailed owns, so it has to exist before the
  // container that creates the socket inside it does.
  ensureDirs();
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
    } else if (await missingAdminSocketMount(existing.Id)) {
      // Older still: its admin API is on a TCP port every deployed container can
      // reach. Replaced, and the autosaved config goes with it, or `--resume` would
      // bring the old listener straight back.
      onLog?.('Replacing the web traffic router so its control port is no longer exposed…');
      await destroyContainer(existing.Id, 5);
      await forgetSavedConfig();
    } else if (existing.State === 'running') {
      // Adopted only if it actually answers.
      //
      // `--resume` reloads the config Caddy saved for itself, and that config names
      // the address its own admin API listens on. So changing where the admin API
      // lives leaves a Caddy that is running, still serving every site, and
      // permanently unreachable: no route ever updates again, no certificate is ever
      // requested, and the only sign is a router marked "down" for a reason nothing
      // explains. The saved config is what pins it, so that is what goes.
      if (await waitForCaddy(5000)) {
        setCaddyHealthy(true);
        return;
      }
      onLog?.("The web traffic router isn't answering, so it is being started again…");
      await destroyContainer(existing.Id, 5);
      await forgetSavedConfig();
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
    env: { CADDY_ADMIN: caddyAdminListen },
    labels: managedLabels({ role: 'proxy' }),
    network: caddyConfig.network,
    ports: {
      [INTERNAL_HTTP]: { host: '0.0.0.0', port: caddyConfig.httpPort },
      [INTERNAL_HTTPS]: { host: '0.0.0.0', port: caddyConfig.httpsPort },
      // Only published where the admin API is still a TCP listener, and then only on
      // loopback. On Linux it is a unix socket and there is no port to publish.
      ...(caddyAdminOverSocket
        ? {}
        : { [caddyConfig.adminPort]: { host: '127.0.0.1', port: caddyConfig.adminPort } }),
    },
    volumes: {
      [caddyConfig.dataVolume]: '/data',
      [`${caddyConfig.dataVolume}-config`]: '/config',
      // A host folder, so Derailed can read the access log without going through
      // Docker. It is the only source of the traffic figures.
      [paths.accessLogs]: '/logs',
      // And the folder the admin socket is created in, so Derailed can reach it
      // without that API being on the network at all.
      ...(caddyAdminOverSocket ? { [paths.caddyAdmin]: CADDY_ADMIN_DIR_IN_CONTAINER } : {}),
    },
    // The dashboard runs on the host, not in a container, so putting it behind a
    // domain means Caddy has to be able to reach back out to the host.
    extraHosts: [`${HOST_GATEWAY}:host-gateway`],
    restartPolicy: 'unless-stopped',
  });
  await startContainer(id);
  setCaddyHealthy(await waitForCaddy());
}

/**
 * Throws away the config Caddy saved for itself, keeping the certificates.
 *
 * Only the autosave lives in `/config`; `/data` holds the certificates and the
 * account key, and losing those would mean asking Let's Encrypt for everything
 * again. Derailed pushes the full configuration seconds later regardless, so there
 * is nothing here worth keeping and something in it actively worth losing.
 */
async function forgetSavedConfig(): Promise<void> {
  await removeVolume(`${caddyConfig.dataVolume}-config`).catch(() => undefined);
  await ensureVolume(`${caddyConfig.dataVolume}-config`, managedLabels({ role: 'proxy' }));
}

/** Whether this container predates the access log folder being mounted in. */
async function missingLogMount(id: string): Promise<boolean> {
  return !(await hasMount(id, '/logs'));
}

/**
 * Whether this container predates the admin API moving off the network.
 *
 * Only asked where a socket is what we would create, or every boot on a Mac would
 * decide the container it just made is out of date and replace it again.
 */
async function missingAdminSocketMount(id: string): Promise<boolean> {
  if (!caddyAdminOverSocket) return false;
  return !(await hasMount(id, CADDY_ADMIN_DIR_IN_CONTAINER));
}

async function hasMount(id: string, destination: string): Promise<boolean> {
  const inspected = await inspectContainer(id).catch(() => null);
  // Nothing to go on, so nothing is claimed. Replacing a container we could not
  // inspect would turn a transient Docker hiccup into downtime for every site.
  if (!inspected) return true;
  const mounts = (inspected as unknown as { Mounts?: { Destination?: string }[] }).Mounts ?? [];
  return mounts.some((mount) => mount.Destination === destination);
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
    const [url, init] = adminRequest('/config/', { signal: AbortSignal.timeout(2000) });
    const response = await fetch(url, init);
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
    const [url, init] = adminRequest('/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(20_000),
    });
    response = await fetch(url, init);
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
    // Pushed with every config, or the first `/load` would move the admin API back
    // onto a TCP port and undo the thing the socket is there to do.
    adminListen: caddyAdminListen,
  });
}

/** The port a visitor actually types (dev uses high ports to avoid needing root). */
export function publicPortSuffix(https: boolean): string {
  if (!isDev) return '';
  return https ? `:${caddyConfig.httpsPort}` : `:${caddyConfig.httpPort}`;
}
