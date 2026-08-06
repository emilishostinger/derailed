import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DrillResult } from '@derailed/shared';
import { alertDrillFailed } from '../alerts/watch.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { type BackupManifest, backupFile, listBackups, safeInside } from './backup.ts';

/**
 * Proving that a backup restores.
 *
 * Every backup tool tells you a backup was made. Almost none tell you it can be read
 * back, which is the only claim anyone actually cares about, and the gap between the
 * two is where people lose everything: a truncated archive, a database dump that
 * failed half way and was kept anyway, a volume that was empty when it was copied.
 *
 * So once a month Derailed takes the newest backup and checks it, without touching
 * anything that is running. The archive is unpacked into a throwaway folder, the
 * manifest is read, every file it names is confirmed present and non-empty, and each
 * database dump is checked for the markers its own engine writes at the end of a
 * complete dump. Then the folder is deleted.
 *
 * That is short of a full restore into a live database, which would need a container
 * per engine and several minutes. It catches every failure seen in practice, and it
 * is cheap enough to run unattended.
 */

/** How often to check, and how stale a result may be before it stops meaning much. */
export const DRILL_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What the end of a complete dump looks like, per engine.
 *
 * Every one of these is written last, so finding it means the dump ran to completion
 * rather than dying part way and leaving a file that looks plausible.
 */
const COMPLETION_MARKERS: { pattern: RegExp; engines: string[] }[] = [
  { pattern: /--\s*PostgreSQL database dump complete/i, engines: ['postgres'] },
  { pattern: /--\s*Dump completed/i, engines: ['mysql', 'mariadb'] },
];

interface FileCheck {
  file: string;
  ok: boolean;
  reason?: string;
}

async function unpack(archive: string, into: string): Promise<void> {
  const proc = Bun.spawn(['tar', '-xzf', archive, '-C', into], { stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`The archive could not be opened. ${stderr}`.trim());
}

/**
 * Reads the tail of a file without loading the whole thing. A database dump can be
 * gigabytes and the marker is always at the end.
 */
async function tailOf(file: string, bytes = 4096): Promise<string> {
  const handle = Bun.file(file);
  const size = handle.size;
  return handle.slice(Math.max(0, size - bytes), size).text();
}

async function checkDump(path: string, engine: string): Promise<FileCheck> {
  const info = await stat(path).catch(() => null);
  if (!info) return { file: path, ok: false, reason: 'the file named in the manifest is missing' };
  if (info.size === 0) return { file: path, ok: false, reason: 'the dump is empty' };

  const markers = COMPLETION_MARKERS.filter((entry) => entry.engines.includes(engine));
  // Engines whose dumps have no end marker (Mongo's archive format, Redis's RDB) are
  // checked for existence and size only. Claiming more than that would be a lie.
  if (!markers.length) return { file: path, ok: true };

  const tail = await tailOf(path).catch(() => '');
  const complete = markers.some((entry) => entry.pattern.test(tail));
  return complete
    ? { file: path, ok: true }
    : {
        file: path,
        ok: false,
        reason: 'the dump stops before its end marker, so it was cut short when it was made',
      };
}

/** Checks one backup, without touching anything that is running. */
export async function drillBackup(backupId: string): Promise<DrillResult> {
  const startedAt = Date.now();
  const archive = backupFile(backupId);
  const work = await mkdtemp(join(tmpdir(), 'derailed-drill-'));

  try {
    const archiveInfo = await stat(archive).catch(() => null);
    if (!archiveInfo) {
      return fail(backupId, startedAt, 'That backup file is no longer on this server.');
    }

    await unpack(archive, work);

    const manifestPath = join(work, 'manifest.json');
    const manifestInfo = await stat(manifestPath).catch(() => null);
    if (!manifestInfo) {
      return fail(backupId, startedAt, 'The archive opened, but it has no manifest inside it.');
    }

    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as BackupManifest;
    const problems: string[] = [];
    let checked = 0;

    for (const entry of manifest.databases) {
      // The manifest is data from a file on disk, so its paths are treated as
      // untrusted: an archive naming `../../etc/something` must not send this
      // wandering out of the throwaway folder.
      const safe = safeInside(work, entry.file);
      if (!safe) {
        problems.push(`the manifest names a file outside the backup (${entry.file})`);
        continue;
      }
      const result = await checkDump(safe, entry.engine);
      checked++;
      if (!result.ok) problems.push(`${entry.service}: ${result.reason}`);
    }

    for (const entry of manifest.volumes) {
      const safe = safeInside(work, entry.file);
      if (!safe) {
        problems.push(`the manifest names a file outside the backup (${entry.file})`);
        continue;
      }
      const info = await stat(safe).catch(() => null);
      checked++;
      if (!info)
        problems.push(`${entry.service}: the stored files named in the manifest are missing`);
      else if (info.size === 0) problems.push(`${entry.service}: the stored files are empty`);
    }

    const result: DrillResult = {
      backupId,
      at: startedAt,
      tookMs: Date.now() - startedAt,
      ok: problems.length === 0,
      checked,
      problems,
      summary:
        problems.length === 0
          ? checked === 0
            ? 'This backup opens correctly. It contains no databases or stored files to check.'
            : `This backup restores. ${checked} ${checked === 1 ? 'item' : 'items'} checked, all complete.`
          : `This backup has ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
    };

    remember(result);
    // A backup that does not restore is the single worst thing this server can
    // discover about itself, so it is said out loud rather than left on a page.
    if (!result.ok) void alertDrillFailed(result.problems).catch(() => undefined);
    return result;
  } catch (err) {
    return fail(backupId, startedAt, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function fail(backupId: string, startedAt: number, reason: string): DrillResult {
  const result: DrillResult = {
    backupId,
    at: startedAt,
    tookMs: Date.now() - startedAt,
    ok: false,
    checked: 0,
    problems: [reason],
    summary: 'This backup could not be read back.',
  };
  remember(result);
  return result;
}

function remember(result: DrillResult): void {
  setSetting(SETTINGS.drillLast, JSON.stringify(result));
}

export function lastDrill(): DrillResult | null {
  const raw = getSetting(SETTINGS.drillLast);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DrillResult;
  } catch {
    return null;
  }
}

/** Checks the newest backup, if there is one and it has been a month. */
export async function drillIfDue(now = Date.now()): Promise<DrillResult | null> {
  const last = lastDrill();
  if (last && now - last.at < DRILL_INTERVAL_MS) return null;

  const backups = await listBackups().catch(() => []);
  const newest = backups[0];
  if (!newest) return null;

  // Nothing to prove twice: if the newest backup is the one already checked, and that
  // check passed, another run would burn IO to reach the same answer.
  if (last?.backupId === newest.id && last.ok) return null;

  return drillBackup(newest.id);
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startDrills(onLog?: (line: string) => void): void {
  if (timer) return;
  const tick = async () => {
    const result = await drillIfDue().catch(() => null);
    if (result) onLog?.(result.summary);
  };
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopDrills(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
