import { FriendlyError } from '../build/git.ts';
import { DockerError, dockerFetch, dockerJson } from './client.ts';
import { MANAGED_FILTER, managedLabels } from './labels.ts';

export interface NetworkSummary {
  Id: string;
  Name: string;
  Labels: Record<string, string> | null;
}

/** Each project gets its own bridge network so unrelated apps can't see each other. */
export function projectNetworkName(projectId: string): string {
  return `derailed-p_${projectId}`;
}

export async function listNetworks(filters = MANAGED_FILTER): Promise<NetworkSummary[]> {
  return dockerJson<NetworkSummary[]>('/networks', { query: { filters } });
}

/** Full detail for one network, including what is attached to it. */
export async function inspectNetwork(
  name: string,
): Promise<{ Containers?: Record<string, unknown> } | null> {
  return dockerJson<{ Containers?: Record<string, unknown> }>(
    `/networks/${encodeURIComponent(name)}`,
  );
}

export async function networkExists(name: string): Promise<boolean> {
  const networks = await dockerJson<NetworkSummary[]>('/networks', {
    query: { filters: JSON.stringify({ name: [name] }) },
  });
  return networks.some((network) => network.Name === name);
}

export async function ensureNetwork(name: string, labels: Record<string, string>): Promise<void> {
  if (await networkExists(name)) return;
  try {
    await dockerFetch('/networks/create', {
      method: 'POST',
      json: { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: labels },
    });
  } catch (err) {
    // Someone else won the race; that's fine.
    if (err instanceof DockerError && /already exists/i.test(err.message)) return;
    /**
     * Docker hands out project networks from a fixed set of address ranges, and there
     * are about thirty of them. Past that it refuses, in its own words: "all predefined
     * address pools have been fully subnetted". That sentence has never told anybody
     * what to do, and it arrives at the worst moment, as a deploy failing for a reason
     * that has nothing to do with the app being deployed.
     *
     * It is reached honestly on a busy server, and reached faster than it looks, because
     * a network outlives the project that made it until housekeeping comes round.
     */
    if (err instanceof DockerError && /address pools/i.test(err.message)) {
      throw new FriendlyError(
        'Docker has run out of private network ranges, so this app has nowhere to sit.',
        'Each project gets its own network, and Docker only has about thirty to give out. Delete a project you have finished with, or run `docker network prune` on the server to clear away the ones nothing is using.',
      );
    }
    throw err;
  }
}

export async function ensureProjectNetwork(projectId: string): Promise<string> {
  const name = projectNetworkName(projectId);
  await ensureNetwork(name, managedLabels({ projectId, role: 'app' }));
  return name;
}

export async function removeNetwork(name: string): Promise<void> {
  try {
    await dockerFetch(`/networks/${name}`, { method: 'DELETE' });
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return;
    throw err;
  }
}
