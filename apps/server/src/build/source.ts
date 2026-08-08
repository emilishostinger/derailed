import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
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

const MAX_LIST = 2000;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

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

export interface SourceEntry {
  /** Relative to the site's root, forward slashes, no leading slash. */
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Every file, flat, sorted by path. A site is files; folders are just their names. */
export async function listSourceFiles(serviceId: string): Promise<SourceEntry[]> {
  const root = await rootFor(serviceId);
  const out: SourceEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_LIST) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= MAX_LIST) return;
      const path = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) continue;
      out.push({
        path: relative(root, path).split('\\').join('/'),
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      });
    }
  }

  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A NUL in the first kilobyte is an image or a font, not a page to edit. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes(0);
}

export async function readSourceFile(
  serviceId: string,
  path: string,
): Promise<{ path: string; contents: string }> {
  const root = await rootFor(serviceId);
  let target: string;
  try {
    target = safeJoin(root, path);
  } catch {
    throw new SourceError('That file is outside the site.');
  }

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
  const root = await rootFor(serviceId);
  let target: string;
  try {
    target = safeJoin(root, path);
  } catch {
    throw new SourceError('That file would land outside the site.');
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_EDIT_BYTES) {
    throw new SourceError('That is too big to save from the editor.');
  }
  const existing = await stat(target).catch(() => null);
  if (existing?.isDirectory()) throw new SourceError('That is a folder.');

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
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
