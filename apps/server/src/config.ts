import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = '0.3.0';

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
  for (const dir of [paths.dataDir, paths.logs, paths.accessLogs, paths.builds, paths.bin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
