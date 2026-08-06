import { statfs } from 'node:fs/promises';
import type { SystemInfo } from '@derailed/shared';
import { isDev, paths, VERSION } from '../config.ts';
import { getBoolSetting, getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { DockerError, version as dockerVersion } from '../docker/client.ts';

let caddyHealthy = false;

/** Phase 1's Caddy manager keeps this fresh; until then it stays false. */
export function setCaddyHealthy(ok: boolean): void {
  caddyHealthy = ok;
}

export function isCaddyHealthy(): boolean {
  return caddyHealthy;
}

async function diskUsage(): Promise<SystemInfo['disk']> {
  try {
    const stats = await statfs(paths.dataDir);
    return {
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * Why Docker isn't answering, in words a person can act on.
 *
 * Derailed pins one Docker API version, and a Docker too old to speak it answers
 * `client version 1.44 is too new. Maximum supported API version is 1.41`, which was
 * passed through to the dashboard exactly as written. That sentence is about Derailed
 * being too new, which reads like Derailed is broken, and it names two version numbers
 * that are neither the one installed nor the one needed. The installer fetches a
 * current Docker, so this is the person who already had an old one from their
 * distribution: `docker.io` on Debian 12 and Ubuntu 22.04 is exactly this case.
 */
export function explainDockerFailure(err: unknown): string {
  if (!(err instanceof DockerError)) {
    return 'Could not reach Docker. Is the Docker service running?';
  }
  if (/maximum supported api version/i.test(err.message)) {
    return 'The Docker on this server is too old for Derailed, which needs Docker 25 or newer. Install the current one with: curl -fsSL https://get.docker.com | sh';
  }
  if (/permission denied/i.test(err.message)) {
    return 'Derailed is not allowed to talk to Docker. It needs to run as root, or as a member of the docker group.';
  }
  return err.message;
}

export async function systemInfo(): Promise<SystemInfo> {
  const [disk, docker] = await Promise.all([
    diskUsage(),
    dockerVersion().then(
      (v) => ({ ok: true, version: v.Version, error: null }),
      (err: unknown) => ({
        ok: false,
        version: null,
        error: explainDockerFailure(err),
      }),
    ),
  ]);

  return {
    version: VERSION,
    serverIp: getSetting(SETTINGS.serverIp),
    serverIpSource:
      (getSetting(SETTINGS.serverIpSource) as SystemInfo['serverIpSource'] | null) ?? 'unknown',
    dockerOk: docker.ok,
    dockerVersion: docker.version,
    dockerError: docker.error,
    caddyOk: caddyHealthy,
    disk,
    setupComplete: getBoolSetting(SETTINGS.setupComplete),
    dev: isDev,
  };
}

/**
 * Best-effort public IP detection. Users can override it in Settings, some VPSes
 * sit behind NAT and the outside world sees a different address.
 */
export async function detectServerIp(): Promise<string | null> {
  if (getSetting(SETTINGS.serverIpSource) === 'manual') return getSetting(SETTINGS.serverIp);
  const sources = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
  for (const url of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const ip = (await response.text()).trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        setSetting(SETTINGS.serverIp, ip);
        setSetting(SETTINGS.serverIpSource, 'detected');
        return ip;
      }
    } catch {
      // try the next source
    }
  }
  return getSetting(SETTINGS.serverIp);
}
