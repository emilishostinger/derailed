import type { FileEntry } from '@derailed/shared';
import { listVolumesFor } from '../db/repo/volumes.ts';
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

export async function readFile(serviceId: string, path: string): Promise<string> {
  const safe = resolveInsideStorage(serviceId, path);
  if (!safe) throw new Error("That file is not part of this app's storage.");

  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('This app is not running.');

  const size = await run(containerId, ['stat', '-c', '%s', '--', safe]);
  if (size.code === 0 && Number(size.out.trim()) > MAX_EDIT_BYTES) {
    throw new Error('That file is too big to open here. Download it instead.');
  }

  const { code, out } = await run(containerId, ['cat', '--', safe]);
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
