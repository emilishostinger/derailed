import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import type { FileEntry } from '@derailed/shared';
import { safeJoin } from './detect.ts';
import { hasUpload, uploadDir } from './upload.ts';

/**
 * Edit a file, and it's live.
 *
 * A dragged-in site's files already live on this machine, under the uploads folder
 * a deploy builds from. Until now the only way to fix a typo in one was to edit it
 * at home and drag the whole folder in again. This is the missing half: read the
 * files, change one, save, and the ordinary deploy pipeline publishes it.
 *
 * Deliberately for upload apps only. A repository app's source of truth is git, and
 * an editor that writes to a checkout the next deploy throws away is a lie with a
 * save button.
 */

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** The same ceiling a dragged-in upload has, so one path in cannot beat another. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export class SourceError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

async function rootFor(serviceId: string): Promise<string> {
  if (!(await hasUpload(serviceId))) {
    throw new SourceError(
      'There are no uploaded files for this app yet.',
      'Drag your folder or a zip onto the app first.',
    );
  }
  return uploadDir(serviceId);
}

/**
 * One name a new file or folder may have, or null.
 *
 * The same rule the storage browser uses: no separators, no dot-names, no NUL, and
 * short enough for any filesystem and a tar header. The separator ban is what stops
 * a "name" being a path that climbs out of the folder it was meant to land in.
 */
export function validName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  if (new TextEncoder().encode(trimmed).length > 100) return null;
  return trimmed;
}

/** A path inside the site, resolved and proved to stay inside it, or a thrown error. */
async function insideSite(serviceId: string, path: string): Promise<string> {
  const root = await rootFor(serviceId);
  try {
    return safeJoin(root, path);
  } catch {
    throw new SourceError('That path is outside the site.');
  }
}

/**
 * One directory of the site, listed the way the storage browser lists a folder,
 * so the same component draws both without knowing which it is looking at.
 *
 * The single root is `/`, which is the site itself. `path` is normalised to a
 * forward-slash path relative to that root, always starting with a slash.
 */
export async function listSourceDir(
  serviceId: string,
  askedPath?: string,
): Promise<{ roots: string[]; path: string; entries: FileEntry[] }> {
  const root = await rootFor(serviceId);
  const target = await insideSite(serviceId, askedPath ?? '/');
  const rel = `/${relative(root, target).split('\\').join('/')}`.replace(/\/+$/, '') || '/';

  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    // A file (or nothing) was asked for as a directory: fall back to the root
    // rather than error, which is what the storage browser does too.
    return listSourceDir(serviceId, '/');
  }

  const names = (await readdir(target).catch(() => [])).sort();
  const entries: FileEntry[] = [];
  for (const name of names) {
    const child = await stat(join(target, name)).catch(() => null);
    if (!child) continue;
    entries.push({
      name,
      directory: child.isDirectory(),
      sizeBytes: child.size,
      modifiedAt: child.mtimeMs,
    });
  }
  // Folders first, then files, each alphabetical: the order people expect.
  entries.sort((a, b) =>
    a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
  );
  return { roots: ['/'], path: rel, entries };
}

/** A NUL in the first kilobyte is an image or a font, not a page to edit. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes(0);
}

export async function readSourceFile(
  serviceId: string,
  path: string,
): Promise<{ path: string; contents: string }> {
  const target = await insideSite(serviceId, path);

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new SourceError('There is no such file.');
  if (info.size > MAX_EDIT_BYTES) {
    throw new SourceError(
      'That file is too big to edit here.',
      'The editor is for pages, styles and scripts; big binary files travel by upload.',
    );
  }

  const bytes = await readFile(target);
  if (looksBinary(bytes)) {
    throw new SourceError(
      'That is not a text file.',
      'Images, fonts and archives are replaced by uploading a new one, not edited.',
    );
  }
  return { path, contents: bytes.toString('utf8') };
}

/** Writes one file. New paths are welcome; that is how a 404 page begins. */
export async function writeSourceFile(
  serviceId: string,
  path: string,
  contents: string,
): Promise<void> {
  const target = await insideSite(serviceId, path);
  if (Buffer.byteLength(contents, 'utf8') > MAX_EDIT_BYTES) {
    throw new SourceError('That is too big to save from the editor.');
  }
  const existing = await stat(target).catch(() => null);
  if (existing?.isDirectory()) throw new SourceError('That is a folder.');

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

/** Makes a folder inside the site. */
export async function makeSourceFolder(
  serviceId: string,
  parent: string,
  name: string,
): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new SourceError('That is not a usable folder name.');
  const target = await insideSite(serviceId, `${parent.replace(/\/+$/, '')}/${clean}`);
  if (await stat(target).catch(() => null)) {
    throw new SourceError('Something with that name is already there.');
  }
  await mkdir(target, { recursive: true });
}

/** Renames a file or folder, inside its own directory only. */
export async function renameSourceEntry(
  serviceId: string,
  path: string,
  name: string,
): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new SourceError('That is not a usable name.');
  const from = await insideSite(serviceId, path);
  const info = await stat(from).catch(() => null);
  if (!info) throw new SourceError('There is no such file.');
  // The new name is joined onto the OLD parent, and re-checked: a rename can only
  // move something within the folder it already lives in, never across the tree.
  const to = await insideSite(serviceId, `${dirname(path)}/${clean}`);
  if (await stat(to).catch(() => null)) {
    throw new SourceError('Something with that name is already there.');
  }
  await rename(from, to);
}

/** Deletes a file or folder (and everything under it). The root itself is refused. */
export async function deleteSourceEntry(serviceId: string, path: string): Promise<void> {
  const root = await rootFor(serviceId);
  const target = await insideSite(serviceId, path);
  if (target === root) {
    throw new SourceError('That is the whole site. Delete the app instead.');
  }
  if (!(await stat(target).catch(() => null))) throw new SourceError('There is no such file.');
  await rm(target, { recursive: true, force: true });
}

/** Streams an upload into a folder in the site, size-capped, name-checked. */
export async function uploadIntoSource(
  serviceId: string,
  parent: string,
  name: string,
  size: number,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const clean = validName(name);
  if (!clean) throw new SourceError('That is not a usable file name.');
  if (!Number.isFinite(size) || size < 0 || size > MAX_UPLOAD_BYTES) {
    throw new SourceError('That file is too big to upload.');
  }
  const target = await insideSite(serviceId, `${parent.replace(/\/+$/, '')}/${clean}`);
  const dir = await stat(target).catch(() => null);
  if (dir?.isDirectory()) throw new SourceError('A folder with that name is already there.');
  await mkdir(dirname(target), { recursive: true });
  // Wrapped in a Response so Bun streams it to disk rather than buffering it.
  await Bun.write(target, new Response(body));
}

/** A file's bytes, its size and its base name, for a download. */
export async function downloadSourceFile(
  serviceId: string,
  path: string,
): Promise<{ body: Readable; size: number; name: string }> {
  const target = await insideSite(serviceId, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new SourceError('There is no such file.');
  return { body: createReadStream(target), size: info.size, name: basename(target) };
}

/**
 * The first, plain-language use of the editor: pages for when things go wrong.
 *
 * Self-contained on purpose: an error page that loads a stylesheet is an error page
 * with a second chance to fail.
 */
export function defaultErrorPage(kind: '404' | '500'): string {
  const title = kind === '404' ? 'Page not found' : 'Something went wrong';
  const body =
    kind === '404'
      ? 'That page does not exist here, or it has moved. The address may be misspelt, or the link that sent you may be out of date.'
      : 'The site hit a problem serving this page. It is usually brief; trying again in a minute often works.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #fafafa; color: #1a1a1a; }
  main { text-align: center; padding: 2rem; max-width: 28rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; color: #555; line-height: 1.5; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${body}</p>
  <p><a href="/">Back to the front page</a></p>
</main>
</body>
</html>
`;
}
