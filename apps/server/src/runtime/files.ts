import type { FileEntry } from '@derailed/shared';
import { listVolumesFor } from '../db/repo/volumes.ts';
import { getFileArchive, putFileArchive } from '../docker/archive.ts';
import { dockerFetch, dockerJson } from '../docker/client.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { demultiplex } from '../jobs/run.ts';

/**
 * Files, without SSH.
 *
 * For the WordPress-and-PHP audience, which is the largest self-hosting audience
 * there is, this is the hosting-panel feature they will immediately look for. A theme
 * to upload, an `uploads` folder to check, a config file to read.
 *
 * Everything is confined to the app's own storage. Not to the container: to the paths
 * that were explicitly attached as storage, which are the only places anything is
 * meant to be written and the only places whose contents survive a deploy anyway.
 * A file browser rooted at `/` would be a way to read the environment of every
 * process in the container, and there is already a Terminal tab for people who mean
 * to do that.
 */

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/**
 * Whether a path is inside one of this app's storage folders.
 *
 * The path comes off a URL, so it is not to be trusted. `..` is rejected outright
 * rather than resolved, because resolving is where the subtle mistakes live, and a
 * legitimate path never needs it.
 */
export function resolveInsideStorage(serviceId: string, path: string): string | null {
  if (!path.startsWith('/')) return null;
  if (path.includes('\0')) return null;
  // Any `..` at all, in any position. Nothing legitimate needs one.
  if (path.split('/').includes('..')) return null;

  const roots = listVolumesFor(serviceId).map((volume) => volume.containerPath);
  const clean = path.replace(/\/+$/, '') || '/';

  for (const root of roots) {
    const base = root.replace(/\/+$/, '');
    if (clean === base || clean.startsWith(`${base}/`)) return clean;
  }
  return null;
}

/** The storage folders themselves, which is where browsing starts. */
export function storageRoots(serviceId: string): string[] {
  return listVolumesFor(serviceId).map((volume) => volume.containerPath.replace(/\/+$/, ''));
}

/**
 * A single name, as opposed to a path.
 *
 * Anything that renames or creates takes a name rather than a path, so that a slash
 * cannot walk somewhere else. `resolveInsideStorage` would catch that anyway, but a
 * rule that is checked in one place is a rule that holds when somebody adds the next
 * operation without reading this file first.
 */
export function validName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\0')) return null;
  // The limit on every filesystem anyone will run this on, and on a tar header.
  if (new TextEncoder().encode(trimmed).length > 100) return null;
  return trimmed;
}

function join(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory}/${name}`;
}

/**
 * Where the storage folder itself sits, as opposed to something inside it.
 *
 * A root is a mount point. Renaming or deleting one does not remove the storage:
 * it leaves the app pointed at a folder that is no longer there, which is a broken
 * app with no sign of why. The Storage tab is where storage is removed.
 */
function isRoot(serviceId: string, path: string): boolean {
  return storageRoots(serviceId).includes(path);
}

async function inside(
  serviceId: string,
  path: string,
  noun = 'That file',
): Promise<{ safe: string; containerId: string }> {
  const safe = resolveInsideStorage(serviceId, path);
  if (!safe) throw new Error(`${noun} is not part of this app's storage.`);
  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('This app is not running, so its files cannot be changed.');
  return { safe, containerId };
}

async function run(containerId: string, cmd: string[]): Promise<{ code: number; out: string }> {
  const { Id } = await dockerJson<{ Id: string }>(`/containers/${containerId}/exec`, {
    method: 'POST',
    json: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
  });
  const response = await dockerFetch(`/exec/${Id}/start`, {
    method: 'POST',
    json: { Detach: false, Tty: false },
    timeoutMs: 60_000,
  });
  const out = demultiplex(new Uint8Array(await response.arrayBuffer()));
  const inspected = await dockerJson<{ ExitCode: number | null }>(`/exec/${Id}/json`);
  return { code: inspected.ExitCode ?? 0, out };
}

/**
 * What is in a folder.
 *
 * `find` at depth one rather than `ls`, because `ls` output is for people and parsing
 * it back is guesswork the moment a filename contains a space. The format string here
 * is unambiguous.
 */
export async function listFiles(serviceId: string, path: string): Promise<FileEntry[]> {
  const safe = resolveInsideStorage(serviceId, path);
  if (!safe) throw new Error("That folder is not part of this app's storage.");

  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('This app is not running, so its files cannot be read.');

  const { code, out } = await run(containerId, [
    'find',
    safe,
    '-maxdepth',
    '1',
    '-mindepth',
    '1',
    '-printf',
    '%y\\t%s\\t%T@\\t%f\\n',
  ]);
  if (code !== 0) {
    // BusyBox `find` has no `-printf`, and Alpine images are half of everything here.
    const fallback = await run(containerId, ['ls', '-lA', '--', safe]);
    if (fallback.code !== 0) throw new Error('That folder could not be read.');
    return parseLs(fallback.out);
  }

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [kind = 'f', size = '0', modified = '0', name = ''] = line.split('\t');
      return {
        name,
        directory: kind === 'd',
        sizeBytes: Number(size) || 0,
        modifiedAt: Math.round(Number(modified) * 1000) || 0,
      };
    })
    .filter((entry) => entry.name)
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

/** BusyBox fallback. Less precise, and only used where `find -printf` is missing. */
function parseLs(output: string): FileEntry[] {
  return output
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const name = parts.slice(8).join(' ');
      return {
        name,
        directory: line.startsWith('d'),
        sizeBytes: Number(parts[4]) || 0,
        modifiedAt: 0,
      };
    })
    .filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..');
}

/** Anything bigger is a download, not something to put in a text box. */
export const MAX_EDIT_BYTES = 512 * 1024;

/**
 * Proves the path, once every symlink in it is followed, still lands inside storage.
 *
 * `resolveInsideStorage` is lexical: it rejects `..` and NUL, but it cannot see a
 * symlink, and a symlink is exactly what an app (or its own start-up) can drop inside
 * a volume — `/data/current -> /app`, say, or a link straight at `/proc/self/environ`.
 * `cat --` would follow it and hand back the target's bytes, which for a viewer is a
 * clean way around the env and connection-string walls: the app's own secrets read out
 * through the file browser. So resolve the real path in the container and confirm it is
 * still under a storage root before anything reads it. Fails closed: if the real path
 * cannot be established, the read is refused rather than allowed on trust.
 */
async function realPathInsideStorage(
  serviceId: string,
  containerId: string,
  safe: string,
): Promise<string | null> {
  // `realpath` is a coreutils and a BusyBox applet both, so it is on essentially every
  // image that already has the `cat`/`stat`/`find` this browser leans on.
  const resolved = await run(containerId, ['realpath', '--', safe]);
  if (resolved.code !== 0) return null;
  const real = resolved.out.trim();
  if (!real) return null;
  for (const root of storageRoots(serviceId)) {
    if (real === root || real.startsWith(`${root}/`)) return real;
  }
  return null;
}

export async function readFile(serviceId: string, path: string): Promise<string> {
  const safe = resolveInsideStorage(serviceId, path);
  if (!safe) throw new Error("That file is not part of this app's storage.");

  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('This app is not running.');

  const real = await realPathInsideStorage(serviceId, containerId, safe);
  if (!real) throw new Error("That file is not part of this app's storage.");

  const size = await run(containerId, ['stat', '-c', '%s', '--', real]);
  if (size.code === 0 && Number(size.out.trim()) > MAX_EDIT_BYTES) {
    throw new Error('That file is too big to open here. Download it instead.');
  }

  const { code, out } = await run(containerId, ['cat', '--', real]);
  if (code !== 0) throw new Error('That file could not be read.');
  return out;
}

/**
 * Writes a file back.
 *
 * Through `tee` with the contents on stdin would be the obvious way, and this exec
 * path does not attach stdin. Base64 through the argument list instead, which is safe
 * for any bytes and any quoting, and chunked because an argument list has a limit and
 * a theme file can be larger than it.
 */
export async function writeFile(serviceId: string, path: string, contents: string): Promise<void> {
  const safe = resolveInsideStorage(serviceId, path);
  if (!safe) throw new Error("That file is not part of this app's storage.");
  if (contents.length > MAX_EDIT_BYTES) throw new Error('That is too large to save here.');

  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('This app is not running.');

  const encoded = Buffer.from(contents, 'utf8').toString('base64');
  const chunks = encoded.match(/.{1,60000}/g) ?? [''];

  // Written to a temporary file and moved into place, so a failure half way through
  // leaves the original rather than a truncated one.
  const temporary = `${safe}.derailed-tmp`;
  for (const [index, chunk] of chunks.entries()) {
    const { code } = await run(containerId, [
      '/bin/sh',
      '-c',
      // The chunk is base64, so it contains nothing a shell would act on. The paths
      // are quoted and have already been proved to sit inside this app's storage.
      `printf '%s' "$1" | base64 -d ${index === 0 ? '>' : '>>'} "$2"`,
      'sh',
      chunk,
      temporary,
    ]);
    if (code !== 0) {
      await run(containerId, ['rm', '-f', '--', temporary]);
      throw new Error('That file could not be written.');
    }
  }

  const { code } = await run(containerId, ['mv', '--', temporary, safe]);
  if (code !== 0) {
    await run(containerId, ['rm', '-f', '--', temporary]);
    throw new Error('That file could not be saved.');
  }
}

/** A new, empty folder inside an existing one. */
export async function makeFolder(serviceId: string, parent: string, name: string): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new Error('That is not a name a folder can have.');
  const { safe, containerId } = await inside(serviceId, parent, 'That folder');

  const target = join(safe, clean);
  const exists = await run(containerId, ['test', '-e', target]);
  if (exists.code === 0) throw new Error(`There is already something called ${clean} here.`);

  // Made with the same owner as the folder it sits in, so the app can write to it.
  const { code } = await run(containerId, ['mkdir', '--', target]);
  if (code !== 0) throw new Error('That folder could not be created.');
  await matchOwner(containerId, safe, target);
}

/**
 * Renaming, within the folder something is already in.
 *
 * Moving between folders is not offered. It reads as the same gesture but it is a
 * different set of ways to go wrong, and nobody has asked for it.
 */
export async function renameEntry(serviceId: string, path: string, name: string): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new Error('That is not a name a file can have.');
  const { safe, containerId } = await inside(serviceId, path);
  if (isRoot(serviceId, safe)) {
    throw new Error('That folder is the storage itself, so it cannot be renamed here.');
  }

  const target = join(safe.slice(0, safe.lastIndexOf('/')) || '/', clean);
  if (target === safe) return;
  const exists = await run(containerId, ['test', '-e', target]);
  if (exists.code === 0) throw new Error(`There is already something called ${clean} here.`);

  const { code } = await run(containerId, ['mv', '--', safe, target]);
  if (code !== 0) throw new Error('That could not be renamed.');
}

/** Deletes a file, or a folder and everything in it. There is no undo for this one. */
export async function deleteEntry(serviceId: string, path: string): Promise<void> {
  const { safe, containerId } = await inside(serviceId, path);
  if (isRoot(serviceId, safe)) {
    throw new Error(
      'That folder is the storage itself. Remove it on the Storage tab if you mean to.',
    );
  }

  const { code } = await run(containerId, ['rm', '-rf', '--', safe]);
  if (code !== 0) throw new Error('That could not be deleted.');
}

/**
 * Whatever owns `reference` should own `target` too.
 *
 * Files arrive through Docker's archive endpoint, which extracts as root. A theme
 * uploaded into `wp-content` that PHP cannot then write to is the sort of thing that
 * looks like the upload failed when it plainly succeeded.
 */
async function matchOwner(containerId: string, reference: string, target: string): Promise<void> {
  const owner = await ownerOf(containerId, reference);
  if (!owner) return;
  await run(containerId, ['chown', `${owner.uid}:${owner.gid}`, '--', target]).catch(
    () => undefined,
  );
}

async function ownerOf(
  containerId: string,
  path: string,
): Promise<{ uid: number; gid: number } | null> {
  const { code, out } = await run(containerId, ['stat', '-c', '%u %g', '--', path]);
  if (code !== 0) return null;
  const [uid, gid] = out.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
  return { uid: uid as number, gid: gid as number };
}

/**
 * A file dropped in from the browser, landing in a folder.
 *
 * Streamed the whole way: the request body goes into a tar and the tar goes into
 * Docker without either being held anywhere. It replaces what is there, because that
 * is what somebody re-uploading a corrected file means, and the alternative is a
 * folder full of `style (2).css`.
 */
export async function uploadInto(
  serviceId: string,
  directory: string,
  name: string,
  size: number,
  contents: ReadableStream<Uint8Array>,
): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new Error('That is not a name a file can have.');
  const { safe, containerId } = await inside(serviceId, directory, 'That folder');

  const folder = await run(containerId, ['test', '-d', safe]);
  if (folder.code !== 0) throw new Error('That is not a folder.');

  const owner = await ownerOf(containerId, safe);
  await putFileArchive(containerId, safe, clean, size, contents, owner ?? {});
}

/** A file on its way out to the browser, as bytes rather than as text. */
export async function downloadFile(
  serviceId: string,
  path: string,
): Promise<{ name: string; size: number; body: ReadableStream<Uint8Array> }> {
  const { safe, containerId } = await inside(serviceId, path);
  const { size, body } = await getFileArchive(containerId, safe);
  return { name: safe.slice(safe.lastIndexOf('/') + 1), size, body };
}
