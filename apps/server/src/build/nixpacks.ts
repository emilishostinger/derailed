import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { FriendlyError } from './git.ts';

/**
 * Nixpacks, an open-source builder, turns a repo with no Dockerfile into a
 * runnable image. We use it in "generate" mode. It writes a Dockerfile, and our own
 * Docker client does the build. So every build streams through one code path and we
 * never need the docker CLI on the host.
 *
 * The binary is downloaded once into the data dir, version-pinned.
 */
const PINNED_VERSION = process.env.DERAILED_NIXPACKS_VERSION ?? '1.38.0';
const RELEASES = 'https://github.com/railwayapp/nixpacks/releases';

export const NIXPACKS_DOCKERFILE = '.nixpacks/Dockerfile';

export function nixpacksBinaryPath(): string {
  return join(paths.bin, 'nixpacks');
}

function assetName(version: string): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  return `nixpacks-v${version}-${arch}-${platform}.tar.gz`;
}

async function latestVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      'https://api.github.com/repos/railwayapp/nixpacks/releases/latest',
      {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: string };
    return body.tag_name?.replace(/^v/, '') ?? null;
  } catch {
    return null;
  }
}

async function download(version: string, onLine?: (line: string) => void): Promise<boolean> {
  const url = `${RELEASES}/download/v${version}/${assetName(version)}`;
  onLine?.(`Downloading the builder (nixpacks ${version})…`);

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) return false;

  const tmp = join(paths.bin, `nixpacks-${version}.tar.gz`);
  await Bun.write(tmp, response);

  const proc = Bun.spawn(['tar', '-xzf', tmp, '-C', paths.bin], { stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  await rm(tmp, { force: true });
  if (code !== 0) throw new FriendlyError("Couldn't unpack the builder.", undefined, [stderr]);

  chmodSync(nixpacksBinaryPath(), 0o755);
  return true;
}

let ensuring: Promise<string> | null = null;

/** Downloads nixpacks if it isn't there yet. Concurrent builds share one download. */
export function ensureNixpacks(onLine?: (line: string) => void): Promise<string> {
  const binary = nixpacksBinaryPath();
  if (existsSync(binary)) return Promise.resolve(binary);

  ensuring ??= (async () => {
    await mkdir(paths.bin, { recursive: true });
    if (await download(PINNED_VERSION, onLine)) return binary;

    // The pinned build isn't published for this platform (or was pulled), try latest.
    const latest = await latestVersion();
    if (latest && latest !== PINNED_VERSION && (await download(latest, onLine))) return binary;

    throw new FriendlyError(
      "Derailed couldn't download the builder it uses for projects without a Dockerfile.",
      'Check that this server has internet access, or add a Dockerfile to your repository.',
    );
  })().finally(() => {
    ensuring = null;
  });

  return ensuring;
}

export interface NixpacksPlan {
  providers?: string[];
  phases?: Record<string, { cmds?: string[] }>;
  start?: { cmd?: string };
  variables?: Record<string, string>;
}

async function runNixpacks(
  args: string[],
  onLine?: (line: string, stream: 'build' | 'system') => void,
  timeoutMs = 900_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const binary = await ensureNixpacks((line) => onLine?.(line, 'system'));
  const proc = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NIXPACKS_NO_MUSL: '1' },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Inspects a repo without building it, used to enrich the wizard's detect step. */
export async function nixpacksPlan(dir: string): Promise<NixpacksPlan | null> {
  const result = await runNixpacks(['plan', dir, '--format', 'json'], undefined, 120_000);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as NixpacksPlan;
  } catch {
    return null;
  }
}

/**
 * Generates `.nixpacks/Dockerfile` inside the checkout. The caller then builds it
 * with the normal Docker build path.
 */
export async function generateDockerfile(
  dir: string,
  env: Record<string, string>,
  onLine?: (line: string, stream: 'build' | 'system') => void,
): Promise<void> {
  onLine?.('Working out how to build this project…', 'system');

  // `--no-cache` matters more than it looks: without it Nixpacks emits
  // `RUN --mount=type=cache,…` instructions, which only BuildKit understands. We build
  // through the Docker Engine's /build endpoint, which is the classic builder, and it
  // fails on the very first mount with no useful output. Losing the npm/pip download
  // cache costs a little build time; emitting mounts we can't build costs everything.
  const args = ['build', dir, '--out', dir, '--no-cache'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);

  const result = await runNixpacks(args, onLine);
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
    if (line.trim()) onLine?.(line.trimEnd(), 'build');
  }

  if (result.code !== 0 || !existsSync(join(dir, NIXPACKS_DOCKERFILE))) {
    throw new FriendlyError(
      "Derailed couldn't work out how to build this project.",
      'Adding a Dockerfile to the repository will always work. If you think this should have been detected, the build log below has the details.',
      `${result.stderr}\n${result.stdout}`.split('\n').filter(Boolean).slice(-12),
    );
  }

  await stripBuildKitMounts(join(dir, NIXPACKS_DOCKERFILE));
}

/**
 * Belt and braces for the `--no-cache` flag above. Any `RUN --mount=…` that reaches
 * the classic builder kills the build instantly and without a usable error, so if a
 * future Nixpacks emits one anyway, take it out rather than ship a broken build.
 */
async function stripBuildKitMounts(dockerfilePath: string): Promise<void> {
  const original = await Bun.file(dockerfilePath).text();
  const cleaned = original.replace(/\s--mount=[^\s\\]+/g, '');
  if (cleaned !== original) await Bun.write(dockerfilePath, cleaned);
}
