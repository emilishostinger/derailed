import { markIntentionalStop } from '../runtime/intent.ts';
import { DockerError, dockerFetch, dockerJson } from './client.ts';
import { MANAGED_FILTER } from './labels.ts';

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Created: number;
  /** Only present on the list endpoint, and only for containers that publish any. */
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; FailingStreak: number };
    OOMKilled: boolean;
  };
  Config: {
    Image: string;
    Env: string[] | null;
    Labels: Record<string, string>;
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}

export interface CreateContainerSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  cmd?: string[];
  network?: string;
  /** Extra network aliases so sibling containers can reach this one by service name. */
  aliases?: string[];
  /** container port → host binding, e.g. { 3000: { host: '127.0.0.1', port: 34871 } } */
  ports?: Record<number, { host: string; port: number }>;
  /** volume name → path inside the container */
  volumes?: Record<string, string>;
  memoryLimitMb?: number | null;
  restartPolicy?: 'no' | 'unless-stopped' | 'always';
  healthcheck?: { test: string[]; intervalSeconds?: number; retries?: number };
  user?: string;
  /** e.g. `["host.docker.internal:host-gateway"]`, how a container reaches the host. */
  extraHosts?: string[];
}

export async function listContainers(
  filters: string = MANAGED_FILTER,
  all = true,
): Promise<ContainerSummary[]> {
  return dockerJson<ContainerSummary[]>('/containers/json', {
    query: { all, filters },
  });
}

export async function inspectContainer(id: string): Promise<ContainerInspect | null> {
  try {
    return await dockerJson<ContainerInspect>(`/containers/${id}/json`);
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return null;
    throw err;
  }
}

export async function findContainerByName(name: string): Promise<ContainerSummary | null> {
  const containers = await dockerJson<ContainerSummary[]>('/containers/json', {
    query: { all: true, filters: JSON.stringify({ name: [`^/${name}$`] }) },
  });
  return containers[0] ?? null;
}

export async function createContainer(spec: CreateContainerSpec): Promise<string> {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const [containerPort, binding] of Object.entries(spec.ports ?? {})) {
    exposedPorts[`${containerPort}/tcp`] = {};
    portBindings[`${containerPort}/tcp`] = [
      // Port 0 means "any free port". Docker picks one and we read it back.
      { HostIp: binding.host, HostPort: binding.port === 0 ? '' : String(binding.port) },
    ];
  }

  const body = {
    Image: spec.image,
    Cmd: spec.cmd,
    User: spec.user,
    Env: Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: spec.labels ?? {},
    ExposedPorts: exposedPorts,
    Healthcheck: spec.healthcheck
      ? {
          Test: spec.healthcheck.test,
          Interval: (spec.healthcheck.intervalSeconds ?? 10) * 1_000_000_000,
          Timeout: 5_000_000_000,
          Retries: spec.healthcheck.retries ?? 5,
          StartPeriod: 5_000_000_000,
        }
      : undefined,
    HostConfig: {
      PortBindings: portBindings,
      Binds: Object.entries(spec.volumes ?? {}).map(([name, path]) => `${name}:${path}`),
      RestartPolicy: { Name: spec.restartPolicy ?? 'unless-stopped' },
      Memory: spec.memoryLimitMb ? spec.memoryLimitMb * 1024 * 1024 : 0,
      NetworkMode: spec.network,
      ExtraHosts: spec.extraHosts ?? [],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
    NetworkingConfig: spec.network
      ? {
          EndpointsConfig: {
            [spec.network]: { Aliases: spec.aliases ?? [] },
          },
        }
      : undefined,
  };

  const created = await dockerJson<{ Id: string; Warnings: string[] }>('/containers/create', {
    method: 'POST',
    query: { name: spec.name },
    json: body,
  });
  return created.Id;
}

export async function startContainer(id: string): Promise<void> {
  try {
    await dockerFetch(`/containers/${id}/start`, { method: 'POST' });
  } catch (err) {
    // 304 = already started, which is a success as far as we care.
    if (err instanceof DockerError && err.status === 304) return;
    throw err;
  }
}

export async function stopContainer(id: string, graceSeconds = 10): Promise<void> {
  // Recorded before the call so the `die` event can't beat us to it.
  markIntentionalStop(id);
  try {
    await dockerFetch(`/containers/${id}/stop`, {
      method: 'POST',
      query: { t: graceSeconds },
      timeoutMs: (graceSeconds + 15) * 1000,
    });
  } catch (err) {
    if (err instanceof DockerError && (err.status === 304 || err.status === 404)) return;
    throw err;
  }
}

export async function restartContainer(id: string, graceSeconds = 10): Promise<void> {
  await dockerFetch(`/containers/${id}/restart`, {
    method: 'POST',
    query: { t: graceSeconds },
    timeoutMs: (graceSeconds + 20) * 1000,
  });
}

export async function removeContainer(id: string, removeVolumes = false): Promise<void> {
  markIntentionalStop(id);
  try {
    await dockerFetch(`/containers/${id}`, {
      method: 'DELETE',
      query: { v: removeVolumes, force: true },
    });
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return;
    throw err;
  }
}

/** Stop then remove, ignoring anything that is already gone. */
export async function destroyContainer(id: string, graceSeconds = 10): Promise<void> {
  await stopContainer(id, graceSeconds);
  await removeContainer(id);
}

export async function connectToNetwork(
  containerId: string,
  network: string,
  aliases: string[] = [],
): Promise<void> {
  try {
    await dockerFetch(`/networks/${network}/connect`, {
      method: 'POST',
      json: { Container: containerId, EndpointConfig: { Aliases: aliases } },
    });
  } catch (err) {
    // 403 with "already exists" is Docker's way of saying "already connected".
    if (err instanceof DockerError && (err.status === 403 || /already exists/i.test(err.message))) {
      return;
    }
    throw err;
  }
}

export async function disconnectFromNetwork(containerId: string, network: string): Promise<void> {
  try {
    await dockerFetch(`/networks/${network}/disconnect`, {
      method: 'POST',
      json: { Container: containerId, Force: true },
    });
  } catch (err) {
    if (err instanceof DockerError && (err.status === 404 || err.status === 403)) return;
    throw err;
  }
}

/**
 * Every field is optional on purpose. A container that stops while Docker is
 * sampling it answers with nulls, and a stats reading is never worth a crash.
 */
interface RawStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  } | null;
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  } | null;
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } } | null;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
}

/** One-shot stats sample (`stream=false` still returns two samples internally). */
export async function containerStats(id: string): Promise<ContainerStats | null> {
  let raw: RawStats | null;
  try {
    raw = await dockerJson<RawStats | null>(`/containers/${id}/stats`, {
      query: { stream: false, 'one-shot': false },
      timeoutMs: 10_000,
    });
  } catch {
    return null;
  }

  // A container that stops mid-sample answers with a literal `null` body. Reading
  // through it took the whole server down once, and the guards below are no use if
  // this one is missing.
  if (!raw) return null;

  const cpu = raw.cpu_stats;
  const precpu = raw.precpu_stats;
  const memory = raw.memory_stats;
  if (!cpu?.cpu_usage || !precpu?.cpu_usage) return null;

  const cpuDelta = (cpu.cpu_usage.total_usage ?? 0) - (precpu.cpu_usage.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (precpu.system_cpu_usage ?? 0);
  const cores = cpu.online_cpus ?? cpu.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

  // Docker's `usage` includes page cache; subtracting inactive_file matches `docker stats`.
  const memoryBytes = Math.max(0, (memory?.usage ?? 0) - (memory?.stats?.inactive_file ?? 0));

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryBytes,
    memoryLimitBytes: memory?.limit ?? 0,
  };
}
