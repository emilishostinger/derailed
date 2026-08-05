import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FriendlyError } from './git.ts';

/**
 * Unpacking a zip, without needing `unzip` to be installed.
 *
 * This used to shell out. Then a real server turned out not to have the binary, and
 * every dropped website failed with a 500 and nothing a person could act on. Dragging
 * a folder in is meant to be the path for someone who has never opened a terminal, so
 * it cannot rest on what a distribution happened to include.
 *
 * Only the two compression methods that exist in practice are supported: stored, and
 * deflate. Anything else in a zip today came out of a tool that also offers one of
 * these, and guessing at the rest would be more failure modes, not fewer.
 */

const SIGNATURE = {
  endOfCentralDirectory: 0x06054b50,
  zip64Locator: 0x07064b50,
  zip64End: 0x06064b50,
  centralFile: 0x02014b50,
} as const;

const METHOD = { stored: 0, deflate: 8 } as const;

/** Uncompressed ceiling, so a small file that expands enormously can't fill the disk. */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface ExtractResult {
  files: number;
  bytes: number;
}

export async function extractZip(archive: string, destination: string): Promise<ExtractResult> {
  const buffer = Buffer.from(await Bun.file(archive).arrayBuffer());
  const directory = findCentralDirectory(buffer);

  let files = 0;
  let bytes = 0;

  let offset = directory.offset;
  for (let index = 0; index < directory.count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIGNATURE.centralFile) {
      throw new FriendlyError("Derailed couldn't read that zip file.", 'It looks damaged.');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    // A symlink in an archive can point anywhere on the host. Skipped, not followed.
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) continue;
    if (name.endsWith('/')) continue;

    const target = safeJoin(destination, name);
    if (!target) continue;

    bytes += uncompressedSize;
    if (bytes > MAX_TOTAL_BYTES) {
      throw new FriendlyError(
        'That zip file unpacks to more than Derailed accepts.',
        'Remove anything that can be rebuilt, like node_modules, and zip it again.',
      );
    }

    const contents = readEntry(buffer, localOffset, method, compressedSize, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    files++;
  }

  return { files, bytes };
}

/** Reads one file's bytes, using the local header for where its data actually starts. */
function readEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  name: string,
): Buffer {
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + compressedSize);

  if (method === METHOD.stored) return Buffer.from(data);
  if (method === METHOD.deflate) {
    try {
      return inflateRawSync(data);
    } catch {
      throw new FriendlyError(
        `Derailed couldn't unpack "${name}" from that zip file.`,
        'It may be damaged. Try zipping the folder again.',
      );
    }
  }

  throw new FriendlyError(
    `"${name}" is compressed in a way Derailed doesn't read.`,
    'Zip the folder with the normal setting, or the one your operating system uses by default.',
  );
}

/**
 * Keeps entries inside the destination.
 *
 * "../../etc/cron.d/anything" is a real thing archives contain, and writing where an
 * archive asks rather than where it belongs is how unpacking a file becomes running
 * someone else's code.
 */
function safeJoin(destination: string, name: string): string | null {
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;

  const target = normalize(join(destination, cleaned));
  if (target !== destination && !target.startsWith(destination + sep)) return null;
  return target;
}

function findCentralDirectory(buffer: Buffer): { offset: number; count: number } {
  // The end record is last, but a trailing comment can follow it, so scan backwards.
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) !== SIGNATURE.endOfCentralDirectory) continue;

    const count = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);

    // Zip64: the real values live in a second record when either overflows 32 bits.
    if (count === 0xffff || offset === 0xffffffff) {
      return findZip64Directory(buffer, at);
    }
    return { offset, count };
  }

  throw new FriendlyError(
    "That doesn't look like a zip file.",
    'Make sure it is a .zip, not a .tar.gz, .rar or .7z.',
  );
}

function findZip64Directory(buffer: Buffer, endOffset: number): { offset: number; count: number } {
  const locator = endOffset - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== SIGNATURE.zip64Locator) {
    throw new FriendlyError("Derailed couldn't read that zip file.", 'It looks damaged.');
  }

  const end = Number(buffer.readBigUInt64LE(locator + 8));
  if (buffer.readUInt32LE(end) !== SIGNATURE.zip64End) {
    throw new FriendlyError("Derailed couldn't read that zip file.", 'It looks damaged.');
  }

  return {
    count: Number(buffer.readBigUInt64LE(end + 32)),
    offset: Number(buffer.readBigUInt64LE(end + 48)),
  };
}
