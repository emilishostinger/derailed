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
const PINNED_VERSION = '1.38.0';
const RELEASES = 'https://github.com/railwayapp/nixpacks/releases';

export const NIXPACKS_DOCKERFILE = '.nixpacks/Dockerfile';

/**
 * The exact builds Derailed will run, by content.
 *
 * This binary is executed as root on the server, so it gets the same treatment as
 * Derailed's own update: what arrives is checked against what was expected, and if it
 * does not match it is thrown away rather than run. Nixpacks publishes no checksum
 * file of its own, so the digests are recorded here, taken from the release above.
 *
 * This is also why there is no "fall back to whatever is newest" any more. That
 * fallback meant a pinned version was only pinned while the pinned asset kept
 * resolving: the moment it did not, the server downloaded and ran an unreviewed
 * release, which is the opposite of what pinning is for. If a new one is wanted, it
 * is a change to this table and a release of Derailed.
 */
const PINNED_DIGESTS: Record<string, string> = {
  'aarch64-unknown-linux-musl': 'd6e668241ab762c3c7ab21e1d235bc535272ba600f1e039bd000190905c7d21c',
  'x86_64-unknown-linux-musl': 'b6a76ae7c7e23962797d597f6f34f5ddb1419d70628f4404a484b4dbb0580866',
  'aarch64-apple-darwin': 'eb2856d4a9c86b2ea624969951995670312d4376652450e2176b34a74a9d5668',
  'x86_64-apple-darwin': 'cc8856e0c935673b5815fbb3529ce7046424ecd13cfccf3557d4d54493c28be4',
};

export function nixpacksBinaryPath(): string {
  return join(paths.bin, 'nixpacks');
}

/** `aarch64-unknown-linux-musl` and friends: the half of the asset name that varies. */
export function nixpacksTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  return `${arch}-${platform}`;
}

function assetName(version: string): string {
  return `nixpacks-v${version}-${nixpacksTarget()}.tar.gz`;
}

/** The digest this machine's build must have, or null if none was recorded for it. */
export function expectedDigest(target: string = nixpacksTarget()): string | null {
  return PINNED_DIGESTS[target] ?? null;
}

async function download(version: string, onLine?: (line: string) => void): Promise<void> {
  const target = nixpacksTarget();
  const expected = expectedDigest(target);
  if (!expected) {
    throw new FriendlyError(
      `Derailed has no checked build of its builder for ${target}.`,
      'Add a Dockerfile to your repository and it will be built from that instead.',
    );
  }

  const url = `${RELEASES}/download/v${version}/${assetName(version)}`;
  onLine?.(`Downloading the builder (nixpacks ${version})…`);

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) {
    throw new FriendlyError(
      `Derailed couldn't download the builder (HTTP ${response.status}).`,
      'Check that this server has internet access, or add a Dockerfile to your repository.',
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    // Nothing is written to disk, so there is nothing left behind to be run later.
    throw new FriendlyError(
      "The builder Derailed downloaded wasn't the one it expected, so it was thrown away.",
      'Nothing was installed. Add a Dockerfile to your repository to build without it.',
    );
  }

  const tmp = join(paths.bin, `nixpacks-${version}.tar.gz`);
  await Bun.write(tmp, bytes);

  const proc = Bun.spawn(['tar', '-xzf', tmp, '-C', paths.bin], { stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  await rm(tmp, { force: true });
  if (code !== 0) throw new FriendlyError("Couldn't unpack the builder.", undefined, [stderr]);

  chmodSync(nixpacksBinaryPath(), 0o755);
}

let ensuring: Promise<string> | null = null;

/** Downloads nixpacks if it isn't there yet. Concurrent builds share one download. */
export function ensureNixpacks(onLine?: (line: string) => void): Promise<string> {
  const binary = nixpacksBinaryPath();
  if (existsSync(binary)) return Promise.resolve(binary);

  ensuring ??= (async () => {
    await mkdir(paths.bin, { recursive: true });
    await download(PINNED_VERSION, onLine);
    return binary;
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

/** What to call a Nixpacks provider in a sentence a person reads. */
const PROVIDER_LABELS: Record<string, string> = {
  node: 'Node.js',
  php: 'PHP',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java',
  deno: 'Deno',
  elixir: 'Elixir',
  csharp: '.NET',
  staticfile: 'static site',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
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
