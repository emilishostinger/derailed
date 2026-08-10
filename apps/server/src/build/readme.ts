import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { fetchPublic } from '../util/net.ts';

/**
 * The app's own README, shown inside Derailed.
 *
 * For a repository app the file is captured at deploy time, from the checkout
 * that is about to be thrown away, so it matches the version that is actually
 * running and is there when the repository later isn't. Uploaded apps keep
 * their files on disk and are read live. Image apps have no file at all, but
 * Docker Hub serves the page's description over its API, and that is cached
 * here the first time somebody asks.
 */

/** Generous for a README, small for a disk. The rest is cut, not refused. */
const MAX_BYTES = 300_000;

const NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README', 'readme.txt'];

function fileFor(serviceId: string): string {
  return join(paths.dataDir, 'readmes', `${serviceId}.md`);
}

/** Finds a README in a folder without capturing it anywhere. */
export async function readmeInDir(dir: string): Promise<string | null> {
  for (const name of NAMES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      return (await readFile(path, 'utf8')).slice(0, MAX_BYTES);
    } catch {
      // Unreadable is the same as absent; try the next spelling.
    }
  }
  return null;
}

/** Called from the deploy pipeline. The first folder with a README wins. */
export async function captureReadme(serviceId: string, ...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const text = await readmeInDir(dir);
    if (text === null) continue;
    await saveReadme(serviceId, text);
    return;
  }
}

export async function saveReadme(serviceId: string, text: string): Promise<void> {
  await mkdir(join(paths.dataDir, 'readmes'), { recursive: true });
  await writeFile(fileFor(serviceId), text.slice(0, MAX_BYTES));
}

export async function savedReadme(serviceId: string): Promise<string | null> {
  try {
    return await readFile(fileFor(serviceId), 'utf8');
  } catch {
    return null;
  }
}

export async function forgetReadme(serviceId: string): Promise<void> {
  await rm(fileFor(serviceId), { force: true }).catch(() => undefined);
}

/**
 * The description Docker Hub shows on an image's page, for images that live
 * there. Other registries have no API worth guessing at, and answer null.
 */
export async function hubDescription(image: string): Promise<string | null> {
  let repo = image.split('@')[0]?.split(':')[0] ?? '';
  repo = repo.replace(/^docker\.io\//, '');
  if (repo.split('/')[0]?.includes('.')) return null;

  const parts = repo.replace(/^library\//, '').split('/');
  const path =
    parts.length === 1 && parts[0]
      ? `library/${parts[0]}`
      : parts.length === 2
        ? `${parts[0]}/${parts[1]}`
        : null;
  if (!path) return null;

  try {
    const response = await fetchPublic(`https://hub.docker.com/v2/repositories/${path}/`);
    if (!response.ok) return null;
    const body = (await response.json()) as { full_description?: string | null };
    const text = body.full_description?.trim();
    return text ? text.slice(0, MAX_BYTES) : null;
  } catch {
    return null;
  }
}
