import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Docker's /build endpoint wants the build context as a tar stream. Rather than
 * implementing tar, we stream it from the system `tar`, present on every Linux
 * distro and macOS, and far faster than anything we would write.
 *
 * `.dockerignore` is honoured the way the docker CLI does it (the daemon never sees
 * the file), plus `.git` is always excluded: it is often the biggest thing in the
 * repo and a build has no use for it.
 */
export interface TarContext {
  stream: ReadableStream<Uint8Array>;
  /** Resolves to the exit status; non-zero means the context was incomplete. */
  done: Promise<{ ok: boolean; stderr: string }>;
}

export async function readDockerignore(dir: string): Promise<string[]> {
  const file = join(dir, '.dockerignore');
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\.\//, '').replace(/\/+$/, ''));
}

export async function createTarContext(dir: string): Promise<TarContext> {
  const ignores = await readDockerignore(dir);
  const excludes = ['.git', ...ignores];

  const args = ['-cf', '-'];
  // macOS tar stores extended attributes (com.apple.provenance, resource forks) that
  // the Docker daemon then refuses to apply. Linux tar doesn't add them at all.
  if (process.platform === 'darwin') args.push('--no-xattrs', '--no-mac-metadata');
  for (const pattern of excludes) args.push(`--exclude=${pattern}`);
  args.push('-C', dir, '.');

  const proc = Bun.spawn(['tar', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  const done = (async () => {
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, stderr: stderr.trim() };
  })();

  return { stream: proc.stdout as ReadableStream<Uint8Array>, done };
}
