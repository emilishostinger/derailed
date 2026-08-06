import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = '0.6.0';

/** Ports 80/443 need root; in dev we let Caddy use high ports instead. */
export const isDev = process.env.DERAILED_DEV === '1' || process.env.NODE_ENV === 'development';

export const dataDir =
  process.env.DERAILED_DATA ?? (isDev ? join(process.cwd(), '.dev-data') : '/var/lib/derailed');

export const paths = {
  dataDir,
  db: join(dataDir, 'derailed.db'),
  secretKey: join(dataDir, 'secret.key'),
  logs: join(dataDir, 'logs'),
  /** Where Caddy writes its access log, for the traffic figures. */
  accessLogs: join(dataDir, 'access-logs'),
  /** Holds the socket Caddy's admin API listens on. See `caddyAdminSocket`. */
  caddyAdmin: join(dataDir, 'caddy-admin'),
  builds: join(dataDir, 'builds'),
  // Overridable so tests can share one download of the Nixpacks binary rather than
  // fetching 20 MB into a throwaway folder on every run.
  bin: process.env.DERAILED_BIN ?? join(dataDir, 'bin'),
};

export const port = Number(process.env.DERAILED_PORT ?? 8422);
export const host = process.env.DERAILED_HOST ?? '0.0.0.0';

export const dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

/** Caddy publishes these on the host. Dev avoids privileged ports. */
const caddyName = process.env.DERAILED_CADDY_NAME ?? 'derailed-caddy';

/**
 * How Derailed talks to Caddy's admin API.
 *
 * That API has no authentication of its own: whoever can open a connection to it can
 * replace the entire proxy configuration. Caddy is attached to every project network
 * so it can reach the apps it proxies, which means a TCP listener on it is a listener
 * every deployed container can reach, including one running somebody else's code.
 *
 * So on Linux it listens on a unix socket in a folder only root can open, and there
 * is no TCP listener at all. Elsewhere (a Mac running the test suite) a socket across
 * a Docker Desktop bind mount is not dependable, so the loopback-published port is
 * kept: that is a development machine, not a server with strangers' apps on it.
 */
export const caddyAdminOverSocket = process.platform === 'linux';

/** The path inside Caddy's container. Its folder is a bind mount of `paths.caddyAdmin`. */
export const CADDY_ADMIN_DIR_IN_CONTAINER = '/run/caddy-admin';
export const caddyAdminSocket = join(paths.caddyAdmin, 'admin.sock');

export const caddy = {
  containerName: caddyName,
  image: process.env.DERAILED_CADDY_IMAGE ?? 'caddy:2-alpine',
  httpPort: Number(process.env.DERAILED_CADDY_HTTP ?? (isDev ? 8080 : 80)),
  httpsPort: Number(process.env.DERAILED_CADDY_HTTPS ?? (isDev ? 8443 : 443)),
  adminPort: Number(process.env.DERAILED_CADDY_ADMIN ?? 2019),
  network: process.env.DERAILED_CADDY_NETWORK ?? 'derailed',
  dataVolume: `${caddyName}-data`,
};

export function ensureDirs(): void {
  for (const dir of [
    paths.dataDir,
    paths.logs,
    paths.accessLogs,
    paths.caddyAdmin,
    paths.builds,
    paths.bin,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
