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
