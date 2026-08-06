import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import type { SwapState } from '@derailed/shared';
import { isDev } from '../config.ts';

/**
 * Swap, for the machines that need it and do not have it.
 *
 * A 1 GB VPS running a database and a Node build has no headroom at all, and what
 * happens when it runs out is not a warning: the kernel picks a process and kills it.
 * The symptom is an app that "randomly restarts", which is impossible to diagnose from
 * the dashboard and trivial to prevent.
 *
 * Most cheap VPS images ship with no swap file at all. Adding one is four commands
 * nobody who needs it knows to run.
 */
const SWAP_FILE = '/swapfile';

/** Small machines get twice their memory, larger ones get the same again, capped. */
export function suggestedSwapBytes(totalMemoryBytes: number): number {
  const gb = totalMemoryBytes / 1024 ** 3;
  if (gb <= 2) return Math.round(totalMemoryBytes * 2);
  if (gb <= 8) return totalMemoryBytes;
  return 4 * 1024 ** 3;
}

async function currentSwapBytes(): Promise<number> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const line = text.split('\n').find((entry) => entry.startsWith('SwapTotal:'));
    const kb = Number.parseInt(line?.split(/\s+/)[1] ?? '0', 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

export async function swapState(): Promise<SwapState> {
  const totalMemoryBytes = totalmem();
  const bytes = await currentSwapBytes();
  const suggestedBytes = suggestedSwapBytes(totalMemoryBytes);
  // Only Linux has /proc/meminfo and swapon, and only a real server is somewhere
  // Derailed should be creating multi-gigabyte files.
  const canAdd = process.platform === 'linux' && !isDev;

  // Under 4 GB with nothing to fall back on is the case that actually bites. Above
  // that, a machine without swap is usually a deliberate choice.
  const recommended = bytes === 0 && totalMemoryBytes < 4 * 1024 ** 3;

  return {
    bytes,
    totalMemoryBytes,
    recommended,
    suggestedBytes,
    canAdd,
    reason: recommended
      ? 'This server has no swap. When it runs out of memory the system kills whichever app is using the most, which looks like an app restarting for no reason.'
      : null,
  };
}

export class SwapError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'SwapError';
    this.hint = hint;
  }
}

async function run(command: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

/**
 * Creates a swap file and turns it on, permanently.
 *
 * `fallocate` then `dd` as a fallback: `fallocate` is instant but not every
 * filesystem supports it, and a swap file on a filesystem that gave us a sparse file
 * is one the kernel refuses to use.
 */
export async function addSwap(bytes: number): Promise<{ bytes: number }> {
  const state = await swapState();
  if (!state.canAdd) {
    throw new SwapError(
      'Derailed can only add swap on a Linux server.',
      'On a development machine there is nothing to do here.',
    );
  }
  if (state.bytes > 0) {
    throw new SwapError(
      'This server already has swap.',
      'Adding more is unlikely to help. If you need a bigger one, do it by hand.',
    );
  }

  const megabytes = Math.max(256, Math.round(bytes / 1024 ** 2));

  const allocated = await run(['fallocate', '-l', `${megabytes}M`, SWAP_FILE]);
  if (!allocated.ok) {
    const written = await run([
      'dd',
      'if=/dev/zero',
      `of=${SWAP_FILE}`,
      'bs=1M',
      `count=${megabytes}`,
    ]);
    if (!written.ok) {
      throw new SwapError("Derailed couldn't create the swap file.", explain(written.output));
    }
  }

  // Anything but 600 and `mkswap` refuses, which is the right call for a file the
  // kernel will be paging memory into.
  const secured = await run(['chmod', '600', SWAP_FILE]);
  if (!secured.ok) throw new SwapError("Couldn't set permissions on the swap file.");

  const formatted = await run(['mkswap', SWAP_FILE]);
  if (!formatted.ok) {
    await run(['rm', '-f', SWAP_FILE]);
    throw new SwapError("Derailed couldn't prepare the swap file.", explain(formatted.output));
  }

  const enabled = await run(['swapon', SWAP_FILE]);
  if (!enabled.ok) {
    await run(['rm', '-f', SWAP_FILE]);
    throw new SwapError("Derailed couldn't turn the swap file on.", explain(enabled.output));
  }

  await persistInFstab();
  return { bytes: megabytes * 1024 ** 2 };
}

/**
 * Without this the swap file works until the first reboot and then silently does not,
 * which is worse than never having had it: the problem comes back weeks later with
 * nothing to connect it to.
 */
async function persistInFstab(): Promise<void> {
  try {
    const fstab = await readFile('/etc/fstab', 'utf8').catch(() => '');
    if (fstab.includes(SWAP_FILE)) return;
    const line = `${SWAP_FILE} none swap sw 0 0\n`;
    await Bun.write('/etc/fstab', `${fstab}${fstab.endsWith('\n') || !fstab ? '' : '\n'}${line}`);
  } catch {
    // The swap is on and working either way. Failing the whole operation because the
    // file could not be edited would throw away the part that succeeded.
  }
}

function explain(output: string): string | undefined {
  if (/no space left/i.test(output)) {
    return 'There is not enough free disk space for a file that size. Free some up, or choose a smaller one.';
  }
  if (/permission denied|operation not permitted/i.test(output)) {
    return 'Derailed needs to be running as root for this.';
  }
  return output ? output.split('\n').slice(-2).join(' ') : undefined;
}
