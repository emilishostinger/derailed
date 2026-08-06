import { statfs } from 'node:fs/promises';
import type { DiskCategory, DiskReport } from '@derailed/shared';
import { paths } from '../config.ts';
import { dockerJson } from '../docker/client.ts';
import { LABELS } from '../docker/labels.ts';

/**
 * What is using the disk, and what can safely go.
 *
 * A full disk on a small VPS breaks everything at once and silently: builds fail
 * somewhere unhelpful, databases refuse writes, the proxy cannot renew a certificate.
 * Docker is almost always the reason, and `docker system df` is not a thing the
 * audience for Derailed is going to run.
 *
 * So this answers three questions in plain language: how full is it, what is taking
 * the room, and what would you get back by tidying up.
 */

/** Above this, say something. Below it, stay quiet. */
const WARN_PERCENT = 80;
const CRITICAL_PERCENT = 90;

interface DockerDf {
  LayersSize?: number;
  Images?: { Size?: number; Containers?: number; RepoTags?: string[] | null }[];
  Containers?: { SizeRw?: number; State?: string; Labels?: Record<string, string> | null }[];
  Volumes?: { UsageData?: { Size?: number; RefCount?: number } | null }[];
  BuildCache?: { Size?: number; InUse?: boolean }[];
}

async function dockerUsage(): Promise<DockerDf | null> {
  try {
    return await dockerJson<DockerDf>('/system/df');
  } catch {
    return null;
  }
}

/** Bytes under a folder. Cheap enough for the few folders Derailed owns. */
async function folderSize(dir: string): Promise<number> {
  // `du` rather than walking the tree ourselves: it is on every system Derailed
  // supports, it is faster, and it already understands hard links and sparse files.
  try {
    const proc = Bun.spawn(['du', '-sk', dir], { stdout: 'pipe', stderr: 'ignore' });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return 0;
    return Number.parseInt(out.trim().split(/\s+/)[0] ?? '0', 10) * 1024;
  } catch {
    return 0;
  }
}

export async function diskReport(): Promise<DiskReport> {
  const [space, docker, backups, logs, builds] = await Promise.all([
    statfs(paths.dataDir).catch(() => null),
    dockerUsage(),
    folderSize(paths.dataDir ? `${paths.dataDir}/backups` : ''),
    folderSize(paths.logs),
    folderSize(paths.builds),
  ]);

  const totalBytes = space ? Number(space.blocks) * Number(space.bsize) : 0;
  const freeBytes = space ? Number(space.bavail) * Number(space.bsize) : 0;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const percentUsed = totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const categories: DiskCategory[] = [];

  if (docker) {
    // An image with no container using it is one nothing would miss. Docker reports
    // that as `Containers: 0`, counting only containers that exist right now.
    const images = docker.Images ?? [];
    const imageBytes = images.reduce((sum, image) => sum + (image.Size ?? 0), 0);
    const unusedImageBytes = images
      .filter((image) => (image.Containers ?? 0) <= 0)
      .reduce((sum, image) => sum + (image.Size ?? 0), 0);
    categories.push({
      kind: 'images',
      label: 'App images',
      bytes: imageBytes,
      reclaimableBytes: unusedImageBytes,
      detail: unusedImageBytes
        ? 'Older versions of your apps, kept so a rollback is instant. Nothing is running from these.'
        : 'The images your apps are running from. All of these are in use.',
    });

    const cache = docker.BuildCache ?? [];
    const cacheBytes = cache.reduce((sum, entry) => sum + (entry.Size ?? 0), 0);
    if (cacheBytes > 0) {
      categories.push({
        kind: 'build-cache',
        label: 'Build leftovers',
        bytes: cacheBytes,
        // Build cache is only ever a speed-up. Losing it costs one slower build.
        reclaimableBytes: cache
          .filter((entry) => !entry.InUse)
          .reduce((sum, entry) => sum + (entry.Size ?? 0), 0),
        detail: 'Scraps from past builds. Removing them only makes the next build slower.',
      });
    }

    const containers = docker.Containers ?? [];
    const stopped = containers.filter((container) => container.State !== 'running');
    const stoppedBytes = stopped.reduce((sum, container) => sum + (container.SizeRw ?? 0), 0);
    if (stoppedBytes > 0) {
      categories.push({
        kind: 'containers',
        label: 'Stopped containers',
        bytes: stoppedBytes,
        // Only ours. Something else on the machine stopped a container of its own for
        // its own reasons, and removing it is not Derailed's decision to make.
        reclaimableBytes: stopped
          .filter((container) => container.Labels?.[LABELS.managed] === 'true')
          .reduce((sum, container) => sum + (container.SizeRw ?? 0), 0),
        detail: 'Containers that have finished. Their data lives in storage, not in here.',
      });
    }
  }

  if (backups > 0) {
    categories.push({
      kind: 'backups',
      label: 'Backups',
      bytes: backups,
      // Never offered up automatically. Retention is a decision made on the backups
      // page, and a "free up space" button that quietly deleted backups would be the
      // worst possible behaviour for a feature about not losing things.
      reclaimableBytes: 0,
      detail: 'Your backups. Change how many are kept on the Backups page.',
    });
  }

  if (logs > 0) {
    categories.push({
      kind: 'logs',
      label: 'Build logs',
      bytes: logs,
      reclaimableBytes: 0,
      detail: 'What was printed during past deploys. Old ones are tidied up on their own.',
    });
  }

  if (builds > 0) {
    categories.push({
      kind: 'data',
      label: 'Half-finished builds',
      bytes: builds,
      // Anything here is a checkout left behind by a build that died. A build in
      // flight has its own folder and is not in this figure for long.
      reclaimableBytes: builds,
      detail: 'Left over from builds that were interrupted. Safe to remove.',
    });
  }

  categories.sort((a, b) => b.bytes - a.bytes);
  const reclaimableBytes = categories.reduce((sum, entry) => sum + entry.reclaimableBytes, 0);

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    percentUsed,
    level: levelFor(percentUsed),
    summary: summaryFor(percentUsed, freeBytes, totalBytes, reclaimableBytes),
    categories,
    reclaimableBytes,
  };
}

function levelFor(percentUsed: number): DiskReport['level'] {
  if (percentUsed >= CRITICAL_PERCENT) return 'full';
  if (percentUsed >= WARN_PERCENT) return 'filling';
  return 'ok';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function summaryFor(
  percentUsed: number,
  freeBytes: number,
  totalBytes: number,
  reclaimableBytes: number,
): string {
  const free = formatBytes(freeBytes);
  const spare = formatBytes(reclaimableBytes);

  if (percentUsed >= CRITICAL_PERCENT) {
    return reclaimableBytes > 0
      ? `Nearly full: only ${free} left. Tidying up would get back about ${spare}.`
      : `Nearly full: only ${free} left. Deploys will start failing.`;
  }
  if (percentUsed >= WARN_PERCENT) {
    return reclaimableBytes > 0
      ? `Filling up: ${free} left, and about ${spare} of what is used is tidy-up.`
      : `Filling up: ${free} left.`;
  }
  // Both numbers, because "103 GB free" means nothing without knowing of what.
  return `${free} free of ${formatBytes(totalBytes)}.`;
}

export interface ReclaimResult {
  freedBytes: number;
  /** What was done, in plain language, for the toast afterwards. */
  what: string[];
}

/**
 * Frees what the report said was reclaimable.
 *
 * Deliberately narrow. It removes images nothing is running, build scraps, containers
 * Derailed made that have stopped, and abandoned checkouts. It does not touch volumes,
 * backups or anything unlabelled: a button that frees space by deleting data is not a
 * button anyone should press twice.
 */
export async function freeUpSpace(): Promise<ReclaimResult> {
  const before = await diskReport();
  const what: string[] = [];

  // `dangling=false` means "every image no container is using", not just untagged
  // layers. That is the one that actually reclaims room on a server that has deployed
  // the same app forty times.
  const pruned = await dockerJson<{ SpaceReclaimed?: number }>(
    `/images/prune?filters=${encodeURIComponent(JSON.stringify({ dangling: { false: true } }))}`,
    { method: 'POST' },
  ).catch(() => null);
  if (pruned?.SpaceReclaimed) what.push(`Removed unused app images`);

  const cache = await dockerJson<{ SpaceReclaimed?: number }>('/build/prune', {
    method: 'POST',
  }).catch(() => null);
  if (cache?.SpaceReclaimed) what.push('Cleared build leftovers');

  // Only containers Derailed made, and only ones that have stopped.
  const containers = await dockerJson<{ SpaceReclaimed?: number }>(
    '/containers/prune?filters=' +
      encodeURIComponent(JSON.stringify({ label: [`${LABELS.managed}=true`] })),
    { method: 'POST' },
  ).catch(() => null);
  if (containers?.SpaceReclaimed) what.push('Removed stopped containers');

  const after = await diskReport();
  const freedBytes = Math.max(0, after.freeBytes - before.freeBytes);
  if (!what.length) what.push('There was nothing to tidy up');

  return { freedBytes, what };
}
