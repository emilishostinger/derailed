import { DockerError, dockerFetch, dockerJson } from './client.ts';
import { MANAGED_FILTER } from './labels.ts';

export interface VolumeSummary {
  Name: string;
  Labels: Record<string, string> | null;
  Mountpoint: string;
}

export async function listVolumes(filters = MANAGED_FILTER): Promise<VolumeSummary[]> {
  const result = await dockerJson<{ Volumes: VolumeSummary[] | null }>('/volumes', {
    query: { filters },
  });
  return result.Volumes ?? [];
}

export async function ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
  await dockerFetch('/volumes/create', {
    method: 'POST',
    json: { Name: name, Labels: labels },
  });
}

export async function removeVolume(name: string, force = true): Promise<void> {
  try {
    await dockerFetch(`/volumes/${name}`, { method: 'DELETE', query: { force } });
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return;
    throw err;
  }
}
