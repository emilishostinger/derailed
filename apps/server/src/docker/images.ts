import { DockerError, dockerFetch, dockerJson } from './client.ts';

export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  Size: number;
  Labels: Record<string, string> | null;
}

/** Docker's progress stream is newline-delimited JSON; shapes vary by endpoint. */
interface ProgressFrame {
  stream?: string;
  status?: string;
  progress?: string;
  id?: string;
  error?: string;
  errorDetail?: { message: string };
  aux?: { ID?: string };
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<ProgressFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as ProgressFrame;
        } catch {
          // Docker occasionally emits a bare string; surface it as output.
          yield { stream: trimmed };
        }
      }
    }
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as ProgressFrame;
      } catch {
        yield { stream: buffer };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await dockerJson(`/images/${encodeURIComponent(tag)}/json`);
    return true;
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Pulls an image, reporting progress lines. Resolves when the pull finishes;
 * rejects with the plain-language reason if Docker reports an error mid-stream.
 */
export async function pullImage(
  reference: string,
  onProgress?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const [name, tag] = splitReference(reference);
  const response = await dockerFetch('/images/create', {
    method: 'POST',
    query: { fromImage: name, tag },
    signal,
  });
  if (!response.body) return;

  const seen = new Map<string, string>();
  for await (const frame of ndjson(response.body)) {
    if (frame.error || frame.errorDetail) {
      throw new DockerError(
        500,
        frame.errorDetail?.message ?? frame.error ?? 'Pull failed',
        '/images/create',
      );
    }
    if (!onProgress) continue;
    // Collapse the per-layer chatter: only report when a layer changes state.
    const status = frame.status ?? frame.stream?.trim();
    if (!status) continue;
    const key = frame.id ?? '_';
    if (seen.get(key) === status) continue;
    seen.set(key, status);
    onProgress(frame.id ? `${status} ${frame.id}` : status);
  }
}

function splitReference(reference: string): [string, string] {
  const lastColon = reference.lastIndexOf(':');
  const lastSlash = reference.lastIndexOf('/');
  if (lastColon > lastSlash) {
    return [reference.slice(0, lastColon), reference.slice(lastColon + 1)];
  }
  return [reference, 'latest'];
}

export interface BuildOptions {
  /** tar stream of the build context */
  context: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array;
  tag: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  target?: string;
  /**
   * An image whose layers may be reused, on top of whatever is already in the local
   * cache. Named explicitly because the automatic cache only follows a build's own
   * parent chain, and that chain is broken by the very thing Derailed does after
   * every deploy: prune the images nothing is running. Without this, the second
   * deploy of an unchanged project reinstalls every dependency from scratch.
   */
  cacheFrom?: string;
  onLine?: (line: string, stream: 'build' | 'system') => void;
  signal?: AbortSignal;
}

export class BuildFailed extends Error {
  constructor(
    message: string,
    readonly tail: string[],
  ) {
    super(message);
    this.name = 'BuildFailed';
  }
}

/**
 * Builds an image from a tar context. Every output line is forwarded to `onLine`
 * as it arrives; on failure the last meaningful lines come back on the error so
 * the UI can explain what actually broke.
 */
export async function buildImage(options: BuildOptions): Promise<void> {
  const response = await dockerFetch('/build', {
    method: 'POST',
    query: {
      t: options.tag,
      dockerfile: options.dockerfile ?? 'Dockerfile',
      rm: true,
      forcerm: true,
      target: options.target,
      buildargs: options.buildArgs ? JSON.stringify(options.buildArgs) : undefined,
      labels: options.labels ? JSON.stringify(options.labels) : undefined,
      cachefrom: options.cacheFrom ? JSON.stringify([options.cacheFrom]) : undefined,
    },
    headers: { 'content-type': 'application/x-tar' },
    body: options.context as RequestInit['body'],
    signal: options.signal,
    // Bun needs this to stream a request body without buffering it first.
    duplex: 'half',
  } as never);

  if (!response.body) throw new BuildFailed('Docker returned no build output.', []);

  const recent: string[] = [];
  const remember = (line: string) => {
    recent.push(line);
    if (recent.length > 40) recent.shift();
  };

  for await (const frame of ndjson(response.body)) {
    if (frame.error || frame.errorDetail) {
      const message = frame.errorDetail?.message ?? frame.error ?? 'The build failed.';
      throw new BuildFailed(message, recent.slice(-20));
    }
    const text = frame.stream ?? frame.status;
    if (!text) continue;
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\s+$/, '');
      if (!trimmed) continue;
      remember(trimmed);
      options.onLine?.(trimmed, 'build');
    }
  }
}

export async function removeImage(tag: string, force = true): Promise<void> {
  try {
    await dockerFetch(`/images/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
      query: { force, noprune: false },
    });
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return;
    throw err;
  }
}

export async function listImages(filters?: string): Promise<ImageSummary[]> {
  return dockerJson<ImageSummary[]>('/images/json', { query: { filters } });
}
