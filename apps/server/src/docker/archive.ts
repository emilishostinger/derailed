import { dockerFetch } from './client.ts';

/**
 * Getting bytes in and out of a running container.
 *
 * Everything else in the Files tab goes through `exec`, which is fine for text: a
 * config file base64s into an argument list and back. Binaries do not. A 4 MB theme
 * zip through an argument list is a shell that refuses, and reading one back through
 * `cat` is a string of lone surrogates by the time it has been through UTF-8 decoding.
 *
 * Docker already has the right door for this. `PUT /archive` extracts a tar into a
 * folder and `GET /archive` hands one back, both as streams, both byte-exact. The tar
 * here is one file, which is 512 bytes of header this file writes by hand rather than
 * a dependency for a format that has not changed since 1988.
 */

const BLOCK = 512;

/** Octal, NUL-terminated, right-aligned in `width` — how tar stores a number. */
function octal(value: number, width: number): string {
  return `${value
    .toString(8)
    .padStart(width - 1, '0')
    .slice(-(width - 1))}\0`;
}

/**
 * The header block for one regular file.
 *
 * `uid`/`gid` are set from the folder the file is landing in, not left at root. An
 * upload that root owns is a plugin folder WordPress cannot write to afterwards, and
 * the person who dragged it in has no way to see why.
 */
export function tarHeader(
  name: string,
  size: number,
  options: { mode?: number; uid?: number; gid?: number; mtime?: number } = {},
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const put = (text: string, offset: number, width: number) => {
    block.set(encoder.encode(text).slice(0, width), offset);
  };

  const encodedName = encoder.encode(name);
  if (encodedName.length > 100) throw new Error('That name is too long to store.');

  block.set(encodedName, 0);
  put(octal(options.mode ?? 0o644, 8), 100, 8);
  put(octal(options.uid ?? 0, 8), 108, 8);
  put(octal(options.gid ?? 0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(options.mtime ?? Math.floor(Date.now() / 1000), 12), 136, 12);
  // The checksum is computed with its own field read as eight spaces, then written
  // into that field afterwards. A rule that only makes sense once you have seen it.
  block.fill(0x20, 148, 156);
  block[156] = 0x30; // typeflag '0' — a regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);

  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);

  return block;
}

/** How many bytes the tar for a file of `size` occupies, header and padding included. */
export function tarLength(size: number): number {
  const padded = Math.ceil(size / BLOCK) * BLOCK;
  return BLOCK + padded + BLOCK * 2;
}

/**
 * Puts one file into a folder inside a container.
 *
 * The body is streamed rather than assembled, so a large upload passes through
 * without ever being a large string. The length is known in advance, which is what
 * lets it stream at all.
 */
export async function putFileArchive(
  containerId: string,
  directory: string,
  name: string,
  size: number,
  contents: ReadableStream<Uint8Array>,
  ownership: { uid?: number; gid?: number; mode?: number } = {},
): Promise<void> {
  const header = tarHeader(name, size, ownership);
  const padding = new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
  const trailer = new Uint8Array(BLOCK * 2);

  const reader = contents.getReader();
  let written = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(header);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // Short reads mean the tar would describe more than it contains, and the
        // extraction on the other side would take the next header as file content.
        if (written !== size) {
          controller.error(new Error('That upload ended early.'));
          return;
        }
        if (padding.length) controller.enqueue(padding);
        controller.enqueue(trailer);
        controller.close();
        return;
      }
      written += value.length;
      if (written > size) {
        controller.error(new Error('That upload was larger than it declared.'));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  await dockerFetch(`/containers/${containerId}/archive`, {
    method: 'PUT',
    query: { path: directory, noOverwriteDirNonDir: 'true' },
    headers: { 'content-type': 'application/x-tar', 'content-length': String(tarLength(size)) },
    body,
    // Bun needs telling that the whole body is not in hand yet.
    duplex: 'half',
    timeoutMs: 10 * 60_000,
  } as Parameters<typeof dockerFetch>[1]);
}

/**
 * One file out of a container, as bytes.
 *
 * Docker answers with a tar even for a single file, so the header is read off the
 * front and the rest is passed through untouched, cut to the length the header
 * declares. Nothing is buffered: a 300 MB database dump downloads without the server
 * ever holding it.
 */
export async function getFileArchive(
  containerId: string,
  path: string,
): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
  const response = await dockerFetch(`/containers/${containerId}/archive`, {
    query: { path },
    timeoutMs: 10 * 60_000,
  });
  if (!response.body) throw new Error('That file could not be read.');

  const reader = response.body.getReader();
  let header = new Uint8Array(0);
  while (header.length < BLOCK) {
    const { done, value } = await reader.read();
    if (done) throw new Error('That file could not be read.');
    const merged = new Uint8Array(header.length + value.length);
    merged.set(header);
    merged.set(value, header.length);
    header = merged;
  }

  if (header[156] !== 0x30 && header[156] !== 0x00) {
    // Typeflag '5' is a directory, which arrives here if somebody asks to download
    // a folder. Everything else is a link or a device and is not a download either.
    throw new Error('That is a folder, not a file.');
  }

  const sizeField = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
  const size = Number.parseInt(sizeField, 8);
  if (!Number.isFinite(size) || size < 0) throw new Error('That file could not be read.');

  let remaining = size;
  let leftover = header.subarray(BLOCK);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        void reader.cancel();
        return;
      }
      let chunk = leftover;
      leftover = new Uint8Array(0);
      if (chunk.length === 0) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        chunk = value;
      }
      // The tail of the tar is padding and the two empty blocks. They are file
      // content as far as a stream is concerned, so the count is what stops it.
      const wanted = chunk.subarray(0, Math.min(chunk.length, remaining));
      remaining -= wanted.length;
      controller.enqueue(wanted);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  return { size, body };
}
