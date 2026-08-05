import { dockerSocket } from '../config.ts';

/**
 * Thin client for the Docker Engine REST API over the unix socket.
 * Bun's fetch speaks unix sockets natively, so there is no dependency here.
 */
export const DOCKER_API_VERSION = 'v1.44';

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerRequestInit extends RequestInit {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  timeoutMs?: number;
}

function buildUrl(path: string, query?: DockerRequestInit['query']): string {
  const url = new URL(`http://docker${path.startsWith('/') ? path : `/${path}`}`);
  // Prefix the pinned API version unless the caller already pinned one (/v1.44/...).
  if (!/^\/v\d+\.\d+\//.test(url.pathname)) {
    url.pathname = `/${DOCKER_API_VERSION}${url.pathname}`;
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function dockerFetch(path: string, init: DockerRequestInit = {}): Promise<Response> {
  const { query, json, timeoutMs, headers, ...rest } = init;
  const url = buildUrl(path, query);
  const requestHeaders = new Headers(headers);
  let body = init.body ?? null;
  if (json !== undefined) {
    requestHeaders.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      body,
      headers: requestHeaders,
      unix: dockerSocket,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : rest.signal,
    } as RequestInit);
  } catch {
    throw new DockerError(0, `Could not reach Docker at ${dockerSocket}. Is Docker running?`, path);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // plain-text error body
    }
    throw new DockerError(response.status, message || response.statusText, path);
  }
  return response;
}

export async function dockerJson<T>(path: string, init: DockerRequestInit = {}): Promise<T> {
  const response = await dockerFetch(path, init);
  return (await response.json()) as T;
}

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  Os: string;
  Arch: string;
}

export function version(): Promise<DockerVersion> {
  return dockerJson<DockerVersion>('/version', { timeoutMs: 5000 });
}

export async function ping(): Promise<boolean> {
  try {
    await dockerFetch('/_ping', { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}
