import { chmodSync, copyFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VERSION } from './config.ts';

const REPO = process.env.DERAILED_REPO ?? 'emilishostinger/derailed';
const RELEASES = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ReleaseInfo {
  version: string;
  current: string;
  newer: boolean;
  url: string;
  notes: string | null;
}

function assetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `derailed-linux-${arch}`;
}

/** Compares dotted versions numerically, so 0.10.0 beats 0.9.0. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(RELEASES, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
    };
    const version = (body.tag_name ?? '').replace(/^v/, '');
    if (!version) return null;
    return {
      version,
      current: VERSION,
      newer: isNewer(version, VERSION),
      url: body.html_url ?? `https://github.com/${REPO}/releases`,
      notes: body.body ?? null,
    };
  } catch {
    // Offline, rate-limited, whatever. An update check is never worth an error.
    return null;
  }
}

/**
 * Replaces the running binary in place.
 *
 * The swap is a rename within the same directory so it is atomic: either the old
 * binary or the new one is at the path, never a half-written file. The running
 * process keeps its own open file handle, so it survives until systemd restarts it.
 */
export async function selfUpdate(log: (line: string) => void = console.log): Promise<boolean> {
  const target = process.execPath;

  if (!target || target.includes('/bun')) {
    log("This looks like a development run, so there's nothing to update.");
    log('Updating only works on an installed Derailed binary.');
    return false;
  }

  const release = await checkForUpdate();
  if (!release) {
    log("Couldn't reach GitHub to check for updates. Try again in a minute.");
    return false;
  }

  if (!release.newer) {
    log(`You're on ${VERSION}, which is the latest. Nothing to do.`);
    return false;
  }

  log(`Updating ${VERSION} → ${release.version}`);

  const base = `https://github.com/${REPO}/releases/download/v${release.version}`;
  const name = assetName();
  const staged = join(dirname(target), `.derailed-update-${release.version}`);

  try {
    const download = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300_000) });
    if (!download.ok) {
      log(`The download failed (HTTP ${download.status}). Nothing was changed.`);
      return false;
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.byteLength < 1_000_000) {
      log('That download looks too small to be a Derailed build. Nothing was changed.');
      return false;
    }

    // Verify against the published checksums when they exist.
    const sums = await fetch(`${base}/checksums.txt`, { signal: AbortSignal.timeout(30_000) })
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null);
    if (sums) {
      const expected = sums
        .split('\n')
        .find((line) => line.trim().endsWith(name))
        ?.trim()
        .split(/\s+/)[0];
      if (expected) {
        const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
        if (expected !== actual) {
          log("The download didn't match its checksum, so it was thrown away.");
          return false;
        }
        log('Checksum verified.');
      }
    } else {
      log('No checksum published for this release, skipping verification.');
    }

    await Bun.write(staged, bytes);
    chmodSync(staged, 0o755);

    // Keep the old one next to the new one until the very last moment.
    const backup = `${target}.previous`;
    try {
      copyFileSync(target, backup);
    } catch {
      // Not fatal: on some filesystems we simply can't, and the rename below is
      // still atomic.
    }

    renameSync(staged, target);
    log(`Installed ${release.version}.`);

    if (statSync(target).size < 1_000_000) {
      log('Something went wrong with the swap, restoring the previous binary.');
      renameSync(backup, target);
      return false;
    }

    log('');
    log('Restart to run it:  systemctl restart derailed');
    return true;
  } catch (err) {
    try {
      unlinkSync(staged);
    } catch {
      // already gone
    }
    log(`The update failed: ${err instanceof Error ? err.message : String(err)}`);
    log('Nothing was changed.');
    return false;
  }
}
