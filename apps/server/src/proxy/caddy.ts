import {
  CADDY_ADMIN_DIR_IN_CONTAINER,
  CERTS_DIR_IN_CONTAINER,
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
import {
  type CaddyConfig,
  type LoadedCertificate,
  type RouteSpec,
  synthesizeCaddyConfig,
} from './routes.ts';

/**
 * The port the admin API is published on, where it is published at all.
 *
 * Settable because the configured one can already be taken. On Linux this never
 * arises: the admin API is a unix socket and there is no port. On a development Mac
 * it very much does, because 2019 is Caddy's default and anyone working on more than
 * one thing at a time may already be running a Caddy of their own. Left as a
 * mismatched constant, the symptom is a proxy that silently never starts and a
 * dashboard where nothing loads.
 */
let adminPort = caddyConfig.adminPort;

/**
 * The ports visitors reach, on the host side.
 *
 * On a server these are 80 and 443 and they are not negotiable: they are what a web
 * address means. On a development machine they are high ports picked to avoid needing
 * root, and there is nothing special about the particular numbers, so if something
 * else got there first Derailed moves rather than refusing to start.
 */
let httpPort = caddyConfig.httpPort;
let httpsPort = caddyConfig.httpsPort;

/**
 * Where Caddy's admin API listens, from Caddy's own point of view. A unix socket has
 * no port and no address, which is the entire point: see `caddyAdminOverSocket`.
 *
 * Inside the container this is always the standard port, whatever the host side ends
 * up publishing it as. The two used to be the same number, and conflating them meant
 * that moving the host port told Caddy to listen somewhere the mapping did not point.
 */
export function caddyAdminListen(): string {
  return caddyAdminOverSocket
    ? `unix/${CADDY_ADMIN_DIR_IN_CONTAINER}/admin.sock`
    : `0.0.0.0:${INTERNAL_ADMIN}`;
}

/** `fetch` options that reach the admin API, over the socket where there is one. */
function adminRequest(path: string, init: RequestInit = {}): [string, RequestInit] {
  if (!caddyAdminOverSocket) return [`http://127.0.0.1:${adminPort}${path}`, init];
  // The host is ignored for a unix socket, but `fetch` still insists on a valid URL.
  return [`http://caddy-admin${path}`, { ...init, unix: caddyAdminSocket } as RequestInit];
}

/**
 * Whether anything on this machine already answers on a port.
 *
 * Asked before publishing the admin port, because Docker's own complaint when the
 * bind fails ("ports are not available: … bind: address already in use") arrives
 * after the container has been created, leaving it in `created` for ever, and says
 * nothing about which of the two Caddys on the machine is the problem.
 */
async function portIsTaken(port: number): Promise<boolean> {
  try {
    using socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** The first free port at or after `from`, or null if forty in a row are all taken. */
async function freePortFrom(from: number): Promise<number | null> {
  for (let candidate = from; candidate < from + 40; candidate++) {
    if (!(await portIsTaken(candidate))) return candidate;
  }
  return null;
}

/**
 * Settles on ports that are actually available.
 *
 * Only in development, and only because a development machine is a machine with other
 * things on it. A server that cannot bind port 80 has a real problem that moving to
 * 8081 would hide rather than solve, so there the conflict is reported instead: see
 * `explainPortConflict`.
 */
async function resolvePorts(onLog?: (line: string) => void): Promise<void> {
  if (!isDev) return;

  const wanted: [string, number, (port: number) => void][] = [
    ['the web', httpPort, (port) => (httpPort = port)],
    ['secure web', httpsPort, (port) => (httpsPort = port)],
  ];
  // Only a published admin port can clash. On Linux it is a socket in a folder of ours.
  if (!caddyAdminOverSocket) {
    wanted.push(['the router control', adminPort, (port) => (adminPort = port)]);
  }

  for (const [what, current, set] of wanted) {
    if (!(await portIsTaken(current))) continue;
    const free = await freePortFrom(current + 1);
    if (free === null) continue;
    onLog?.(
      `Port ${current} (${what} port) is in use by something else, so Derailed will use ${free} instead.`,
    );
    set(free);
  }
}

/**
 * What to say when a port cannot be had and moving is not an option.
 *
 * On a server this is nearly always another web server left running: Apache and nginx
 * both install themselves listening on port 80, and Docker reports it as an endpoint
 * programming failure, which tells nobody anything.
 */
export function explainPortConflict(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  if (!/address already in use|port is already allocated|ports are not available/i.test(raw)) {
    return null;
  }
  const port = raw.match(/(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/)?.[1];
  const which = port ? `Port ${port} on this server is` : 'The ports Derailed needs are';
  return `${which} already being used by something else, so the web traffic router could not start. Another web server (often Apache or nginx) is the usual reason. Stop it, or remove it, and Derailed will take over the port on its next attempt.`;
}

/** Resolvable inside Caddy's container thanks to the host-gateway mapping below. */
export const HOST_GATEWAY = 'host.docker.internal';

/** Inside the container Caddy always uses the standard ports; the host mapping varies. */
const INTERNAL_HTTP = 80;
const INTERNAL_HTTPS = 443;
const INTERNAL_ADMIN = 2019;

/**
 * Docker's own words, trimmed to the part worth reading.
 *
 * Its port messages arrive as one long line repeating the mapping three times; the
 * tail is the only bit that says what actually went wrong.
 */
function reasonFor(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/address already in use|ports are not available/i.test(raw)) {
    return 'something else is using that port';
  }
  return raw.split('\n')[0]?.slice(0, 120) ?? 'unknown';
}

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
    } else if (await missingCertsMount(existing.Id)) {
      // Older than the free secured address, so it has nowhere to read a certificate
      // Derailed obtained itself from. Without the mount, claiming one would appear to
      // work and then be rejected by a proxy that cannot open the file.
      onLog?.('Replacing the web traffic router so it can serve your certificates…');
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
      try {
        await startContainer(existing.Id);
        setCaddyHealthy(await waitForCaddy());
        return;
      } catch (err) {
        // A container that cannot start is not a container to keep trying to start.
        //
        // The usual cause is a published port that was free when this container was
        // created and is not free now, and the usual result was a container parked in
        // `created` for ever: every later boot found it, tried to start it, failed the
        // same way, and left the machine with no proxy and no explanation. Throwing it
        // away and building a fresh one gets a new port chosen below.
        onLog?.(`That didn't work (${reasonFor(err)}), so it is being rebuilt…`);
        await destroyContainer(existing.Id, 5).catch(() => undefined);
      }
    }
  }

  // Only now, with nothing of ours holding them, is it worth asking whether the ports
  // are free: doing it earlier would find our own container and move off a port that
  // was about to be released.
  await resolvePorts(onLog);

  if (!(await imageExists(caddyConfig.image))) {
    onLog?.(`Downloading ${caddyConfig.image}…`);
    await pullImage(caddyConfig.image, onLog);
  }

  // Every fresh container starts from nothing.
  //
  // `--resume` reloads the config Caddy saved for itself, and that config carries the
  // address its own admin API listens on. The saved config outlives the container, so
  // a new one built with a different admin address resumes the old address instead:
  // Caddy comes up, listens somewhere the port mapping does not point, and is
  // unreachable for ever. Nothing updates, no certificate is ever renewed, and the
  // only symptom is a proxy that answers nothing.
  //
  // Restarts are unaffected, and they are where `--resume` earns its place: a server
  // rebooting keeps serving every site before Derailed has finished starting. This
  // only discards the autosave when a container is being built, where there is no
  // continuity to preserve and a stale admin address to lose.
  await forgetSavedConfig();

  onLog?.('Starting the web traffic router…');
  const id = await createContainer({
    name: caddyConfig.containerName,
    image: caddyConfig.image,
    // `--resume` reloads the config Caddy autosaved, so a restart keeps serving.
    cmd: ['caddy', 'run', '--resume'],
    env: { CADDY_ADMIN: caddyAdminListen() },
    labels: managedLabels({ role: 'proxy' }),
    network: caddyConfig.network,
    ports: {
      [INTERNAL_HTTP]: { host: '0.0.0.0', port: httpPort },
      [INTERNAL_HTTPS]: { host: '0.0.0.0', port: httpsPort },
      // Only published where the admin API is still a TCP listener, and then only on
      // loopback. On Linux it is a unix socket and there is no port to publish.
      // Inside the container it is always the standard 2019; only the host side moves.
      ...(caddyAdminOverSocket
        ? {}
        : { [INTERNAL_ADMIN as number]: { host: '127.0.0.1', port: adminPort } }),
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
      // Certificates Derailed obtained itself, for the free address. Always mounted,
      // whether or not one has been claimed, so claiming one later does not mean
      // replacing the container and dropping every connection through it.
      [paths.certs]: CERTS_DIR_IN_CONTAINER,
    },
    // The dashboard runs on the host, not in a container, so putting it behind a
    // domain means Caddy has to be able to reach back out to the host.
    extraHosts: [`${HOST_GATEWAY}:host-gateway`],
    restartPolicy: 'unless-stopped',
  });
  try {
    await startContainer(id);
  } catch (err) {
    // Leaving a container that cannot start would mean every later boot found it,
    // tried it, and failed the same way, which is how a machine ends up with no proxy
    // and nothing saying why.
    await destroyContainer(id, 5).catch(() => undefined);
    setCaddyHealthy(false);
    const explained = explainPortConflict(err);
    throw explained ? new CaddyUnavailable(explained) : err;
  }
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

/** Whether this container predates Derailed obtaining certificates of its own. */
async function missingCertsMount(id: string): Promise<boolean> {
  return !(await hasMount(id, CERTS_DIR_IN_CONTAINER));
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

export function buildCaddyConfig(
  routes: RouteSpec[],
  certificates: LoadedCertificate[] = [],
): CaddyConfig {
  return synthesizeCaddyConfig(routes, {
    // Container-internal ports; the host mapping is set when the container is created.
    httpPort: INTERNAL_HTTP,
    httpsPort: INTERNAL_HTTPS,
    // Pushed with every config, or the first `/load` would move the admin API back
    // onto a TCP port and undo the thing the socket is there to do.
    adminListen: caddyAdminListen(),
    certificates,
  });
}

/**
 * The port a visitor actually types (dev uses high ports to avoid needing root).
 *
 * Reads the port that was settled on rather than the one that was asked for, since
 * in development those differ whenever something else got there first.
 */
export function publicPortSuffix(https: boolean): string {
  if (!isDev) return '';
  return https ? `:${httpsPort}` : `:${httpPort}`;
}
