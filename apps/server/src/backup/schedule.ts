import type { BackupSchedule } from '@derailed/shared';
import { listProjects, setProjectBackupSchedule } from '../db/repo/projects.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { publish } from '../events/bus.ts';
import { createBackup, pruneBackups, retention } from './backup.ts';
import { copyOffsite, pruneOffsite } from './offsite.ts';

/**
 * Scheduled backups.
 *
 * Deliberately coarse: off, daily or weekly. An interval in hours is a question
 * nobody wants to be asked, and the honest answer for a personal server is "once a
 * day is plenty".
 */
const INTERVALS: Record<Exclude<BackupSchedule, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function setProjectSchedule(projectId: string, schedule: BackupSchedule): void {
  setProjectBackupSchedule(projectId, schedule);
}

/** Projects that are backed up on their own, and how often. */
export function scheduledProjects(): {
  id: string;
  name: string;
  schedule: Exclude<BackupSchedule, 'off'>;
}[] {
  const scheduled = [];
  for (const project of listProjects()) {
    if (project.backupSchedule === 'off') continue;
    scheduled.push({ id: project.id, name: project.name, schedule: project.backupSchedule });
  }
  return scheduled;
}

export function lastRunAt(): number | null {
  const value = getSetting(SETTINGS.backupLastRun);
  return value ? Number(value) : null;
}

/** When the soonest project is next due. Null when nothing is scheduled at all. */
export function nextRunAt(): number | null {
  const scheduled = scheduledProjects();
  if (!scheduled.length) return null;
  const soonest = Math.min(...scheduled.map((entry) => INTERVALS[entry.schedule]));
  return (lastRunAt() ?? Date.now()) + soonest;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Checked every fifteen minutes rather than scheduled precisely, so a restart can't miss a run. */
export function startBackupSchedule(): void {
  if (timer) return;
  timer = setInterval(() => void maybeRun(), 15 * 60 * 1000);
  timer.unref?.();
  void maybeRun();
}

export function stopBackupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function maybeRun(): Promise<void> {
  const now = Date.now();
  const last = lastRunAt() ?? 0;

  for (const project of listProjects()) {
    if (project.backupSchedule === 'off') continue;
    if (now - last < INTERVALS[project.backupSchedule]) continue;

    try {
      const made = await createBackup(project.id);
      // Off the machine as soon as it exists. A backup on the same disk as the thing
      // it backs up does nothing about the failure that actually loses data.
      await copyOffsite(made.id).catch((err) => {
        publish('system', {
          type: 'notice',
          level: 'warn',
          message: `${project.name} was backed up, but the copy off this server failed: ${
            err instanceof Error ? err.message : err
          }`,
        });
      });
    } catch (err) {
      publish('system', {
        type: 'notice',
        level: 'warn',
        message: `Couldn't back up ${project.name}: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  await pruneBackups().catch(() => undefined);
  await pruneOffsite(retention().keep).catch(() => undefined);
  setSetting(SETTINGS.backupLastRun, String(Date.now()));
}
