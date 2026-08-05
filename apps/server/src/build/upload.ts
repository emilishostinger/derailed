import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
