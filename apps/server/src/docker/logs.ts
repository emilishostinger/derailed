import type { LogStream } from '@derailed/shared';
import { DockerError, dockerFetch } from './client.ts';

export interface DemuxedChunk {
  stream: 'stdout' | 'stderr';
  data: Uint8Array;
}

/**
 * Docker multiplexes stdout and stderr into one stream when the container has no TTY:
 * each frame is an 8-byte header ([type, 0, 0, 0, size(uint32 big-endian)]) followed
 * by `size` bytes. Frames can be split across chunks, so we buffer.
 */
export async function* demultiplex(body: ReadableStream<Uint8Array>): AsyncGenerator<DemuxedChunk> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;
      }

      while (buffer.length >= 8) {
        const type = buffer[0]!;
        const size = new DataView(buffer.buffer, buffer.byteOffset + 4, 4).getUint32(0, false);
        if (buffer.length < 8 + size) break;
        yield { stream: type === 2 ? 'stderr' : 'stdout', data: buffer.slice(8, 8 + size) };
        buffer = buffer.slice(8 + size);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Turns a byte stream into complete lines, holding back partial trailing lines. */
export class LineAssembler {
  private partial = new Map<string, string>();
  private decoder = new TextDecoder();

  push(key: string, data: Uint8Array): string[] {
    const text = (this.partial.get(key) ?? '') + this.decoder.decode(data, { stream: true });
    const parts = text.split('\n');
    this.partial.set(key, parts.pop() ?? '');
    return parts.map(stripAnsi);
  }

  /** Flush whatever is left when the stream ends. */
  drain(key: string): string[] {
    const rest = this.partial.get(key);
    this.partial.delete(key);
    return rest ? [stripAnsi(rest)] : [];
  }
}

// Build tools love colour codes; the log viewer renders plain text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r/g;
export function stripAnsi(line: string): string {
  return line.replace(ANSI, '').trimEnd();
}

export interface LogOptions {
  follow?: boolean;
  tail?: number;
  since?: number;
  signal?: AbortSignal;
}

export interface StreamedLine {
  stream: LogStream;
  line: string;
}

/**
 * Yields container log lines. With `follow`, the generator stays open until the
 * container stops or the signal aborts.
 */
export async function* streamContainerLogs(
  containerId: string,
  options: LogOptions = {},
): AsyncGenerator<StreamedLine> {
  let response: Response;
  try {
    response = await dockerFetch(`/containers/${containerId}/logs`, {
      query: {
        stdout: true,
        stderr: true,
        follow: options.follow ?? false,
        tail: options.tail ?? 'all',
        since: options.since,
      },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return;
    throw err;
  }
  if (!response.body) return;

  const assembler = new LineAssembler();
  try {
    for await (const chunk of demultiplex(response.body)) {
      for (const line of assembler.push(chunk.stream, chunk.data)) {
        yield { stream: 'runtime', line };
      }
    }
    for (const key of ['stdout', 'stderr']) {
      for (const line of assembler.drain(key)) yield { stream: 'runtime', line };
    }
  } catch (err) {
    // An aborted follow is the normal way these end.
    if ((err as Error)?.name !== 'AbortError') throw err;
  }
}
