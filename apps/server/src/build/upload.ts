import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '../config.ts';
import { FriendlyError } from './git.ts';
import { extractZip } from './zip.ts';

/** Big enough for a real site, small enough that a mistake doesn't fill the disk. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function uploadDir(serviceId: string): string {
  return join(paths.dataDir, 'uploads', serviceId);
}

/**
 * Unpacks a zip someone dragged into the browser and keeps it as the source for that
 * app. Deploys then build from here exactly as they would from a checkout, so
 * detection, Nixpacks, volumes and rollback all behave the same.
 */
export async function storeUpload(serviceId: string, file: File): Promise<{ files: number }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new FriendlyError(
      `That file is ${Math.round(file.size / 1024 / 1024)} MB, which is bigger than Derailed accepts.`,
      'Remove node_modules and any build output, then zip it again.',
    );
  }

  const target = uploadDir(serviceId);
  const staging = `${target}.incoming`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const archive = join(staging, 'source.zip');
  await Bun.write(archive, file);

  // Unpacked in-process. This used to call `unzip`, until a real server turned out
  // not to have it and every dropped website failed with an error nobody could act on.
  try {
    await extractZip(archive, staging);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  await rm(archive, { force: true });

  // Zipping a folder usually produces a single top-level directory. Deploying that
  // wrapper instead of its contents finds nothing to build, so unwrap it.
  const unwrapped = await unwrapSingleDirectory(staging);

  const files = await countFiles(unwrapped);
  if (files === 0) {
    await rm(staging, { recursive: true, force: true });
    throw new FriendlyError('That zip file was empty.');
  }

  await rm(target, { recursive: true, force: true });
  await rename(unwrapped, target);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);

  return { files };
}

/**
 * Folders that are somebody else's build output, never somebody's source.
 *
 * Skipped on the way in rather than refused, because the person dragging a folder in
 * has a `node_modules` in it and should not have to know that. It is also the
 * difference between a 400 kilobyte upload and a 300 megabyte one.
 */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  '.DS_Store',
  '.pytest_cache',
  '.mypy_cache',
]);

export function isSkipped(relativePath: string): boolean {
  return relativePath.split('/').some((part) => SKIP.has(part));
}

/**
 * Where a dropped file is allowed to land.
 *
 * The path comes from a browser and is therefore a request, not an instruction. A
 * `..` in it, an absolute path, or a null byte would each write outside the folder
 * this app is allowed to touch.
 */
export function safeRelativePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.includes('\0')) return null;
  const parts = path.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  if (!parts.length) return null;
  return parts.join('/');
}

/**
 * A folder, dragged in as it sits on somebody's disk.
 *
 * The zip route exists because it always has, and because a zip is what you get when
 * somebody downloads their own project. But nobody keeps their work as a zip, and
 * "compress this first" is a step that only exists because the software asked for it.
 */
export async function storeFolder(
  serviceId: string,
  files: { path: string; file: File }[],
): Promise<{ files: number }> {
  const wanted = files
    .map((entry) => ({ ...entry, path: safeRelativePath(entry.path) }))
    .filter((entry): entry is { path: string; file: File } => !!entry.path)
    .filter((entry) => !isSkipped(entry.path));

  if (!wanted.length) {
    throw new FriendlyError(
      'That folder had nothing in it that Derailed can use.',
      'Drop the folder that has your code in it, not the one above it.',
    );
  }

  const total = wanted.reduce((sum, entry) => sum + entry.file.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new FriendlyError(
      `That folder is ${Math.round(total / 1024 / 1024)} MB, which is bigger than Derailed accepts.`,
      'Build output and dependency folders are already skipped, so this is a lot of source.',
    );
  }

  const target = uploadDir(serviceId);
  const staging = `${target}.incoming`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    for (const entry of wanted) {
      const destination = join(staging, entry.path);
      // Belt and braces. `safeRelativePath` already refused anything that could get
      // out, and this refuses anything that somehow did.
      if (!destination.startsWith(`${staging}/`)) continue;
      await mkdir(dirname(destination), { recursive: true });
      await Bun.write(destination, entry.file);
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  const unwrapped = await unwrapSingleDirectory(staging);
  const count = await countFiles(unwrapped);
  if (count === 0) {
    await rm(staging, { recursive: true, force: true });
    throw new FriendlyError('That folder was empty.');
  }

  await rm(target, { recursive: true, force: true });
  await rename(unwrapped, target);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);

  return { files: count };
}

export async function hasUpload(serviceId: string): Promise<boolean> {
  try {
    return (await stat(uploadDir(serviceId))).isDirectory();
  } catch {
    return false;
  }
}

export async function removeUpload(serviceId: string): Promise<void> {
  await rm(uploadDir(serviceId), { recursive: true, force: true }).catch(() => undefined);
}

async function unwrapSingleDirectory(dir: string): Promise<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    // Zips made on macOS carry this; it is never the app.
    (entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store',
  );
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    return join(dir, entries[0]!.name);
  }
  return dir;
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) count++;
  }
  return count;
}
