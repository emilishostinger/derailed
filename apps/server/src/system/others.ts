import { port as panelPort, VERSION } from '../config.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { listContainers } from '../docker/containers.ts';
import { isManaged } from '../docker/labels.ts';

/**
 * Everything else running on this machine.
 *
 * Derailed hosts your apps, and it is also a thing running on the server, as is
 * anything you installed before you found it. Leaving those out of the dashboard
 * makes it a view of Derailed rather than a view of the machine, and the first
 * question anybody asks about their own server is "what is on it".
 *
 * Read-only on purpose. Derailed did not create these, does not know how they are
 * meant to be run, and a Stop button next to something it cannot bring back would be
 * a trap.
 */
export interface OtherContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  /** Ports published to the outside world, which is what makes one worth noticing. */
  ports: string[];
}

export interface OtherSoftware {
  derailed: {
    version: string;
    address: string | null;
    /** Where its own data lives, since that is what a person would want to back up. */
    dataDir: string;
  };
  containers: OtherContainer[];
}

interface RawPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export async function otherSoftware(dataDir: string): Promise<OtherSoftware> {
  const panel = getSetting(SETTINGS.panelDomain);
  const serverIp = getSetting(SETTINGS.serverIp);

  const all = await listContainers('', true).catch(() => []);
  const containers = all
    .filter((container) => !isManaged(container.Labels))
    .map((container) => ({
      id: container.Id.slice(0, 12),
      name: (container.Names?.[0] ?? '').replace(/^\//, '') || container.Id.slice(0, 12),
      image: container.Image,
      state: container.State,
      status: container.Status,
      ports: publishedPorts(container as unknown as { Ports?: RawPort[] }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    derailed: {
      version: VERSION,
      address: panel ? `https://${panel}` : serverIp ? `http://${serverIp}:${panelPort}` : null,
      dataDir,
    },
    containers,
  };
}

/** Only the ones reachable from outside; internal ports are noise here. */
function publishedPorts(container: { Ports?: RawPort[] }): string[] {
  const seen = new Set<string>();
  for (const port of container.Ports ?? []) {
    if (!port.PublicPort) continue;
    seen.add(`${port.PublicPort} → ${port.PrivatePort}/${port.Type}`);
  }
  return [...seen].sort();
}
