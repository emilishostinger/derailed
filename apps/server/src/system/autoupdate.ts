import { getBoolSetting, getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { packageManager, rebootReason, securityUpgradeCommand } from './updates.ts';

/**
 * Applying the operating system's security updates without being asked.
 *
 * Off by default, and it stays off until somebody says otherwise: updating a stranger's
 * server on a timer is a decision, not a nicety. What it does when switched on is
 * deliberately narrow, which is the only way this is safe to leave running.
 *
 * **Security updates only, and only where the manager can tell the difference.** Three
 * of the six can. Pacman and apk have no notion of a security update: Arch and Alpine
 * ship one stream, and "just the security ones" there means everything. Upgrading a
 * whole machine on a timer under a heading that says security is how somebody's
 * afternoon disappears, so on those two this simply says it cannot.
 *
 * **It never reboots.** Some updates only take effect after a restart, and the right
 * moment for that is a decision about somebody's visitors rather than about packages.
 * Derailed says a restart is needed and leaves the timing alone.
 */

/** Once a day. Security updates are published on a schedule measured in days. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AutoUpdateState {
  enabled: boolean;
  /** Null when this machine's package manager cannot separate security updates. */
  supported: boolean;
  manager: string | null;
  lastRunAt: number | null;
  lastResult: string | null;
  rebootRequired: boolean;
  rebootReason: string | null;
}

export async function autoUpdateState(): Promise<AutoUpdateState> {
  const manager = packageManager();
  const reason = await rebootReason();
  return {
    enabled: getBoolSetting(SETTINGS.autoSecurityUpdates),
    supported: manager !== null && securityUpgradeCommand(manager) !== null,
    manager,
    lastRunAt: Number(getSetting(SETTINGS.autoUpdateLastRun) ?? '') || null,
    lastResult: getSetting(SETTINGS.autoUpdateLastResult),
    rebootRequired: reason !== null,
    rebootReason: reason,
  };
}

/**
 * Runs the security upgrade, once, and records what happened.
 *
 * The result is stored rather than thrown because nothing is waiting for it: this
 * runs on a timer at four in the morning, and the only place an outcome can usefully
 * go is a line on the Updates page.
 */
export async function runSecurityUpdates(): Promise<string> {
  const manager = packageManager();
  const cmd = manager && securityUpgradeCommand(manager);
  if (!cmd) {
    const message = manager
      ? `${manager} cannot separate security updates from the rest, so nothing was applied.`
      : 'Derailed does not recognise this machine’s package manager.';
    setSetting(SETTINGS.autoUpdateLastResult, message);
    setSetting(SETTINGS.autoUpdateLastRun, String(Date.now()));
    return message;
  }

  let message: string;
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), 15 * 60_000);
    const [, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    message = code === 0 ? 'Security updates applied.' : `The update command exited ${code}.`;
  } catch (err) {
    message = err instanceof Error ? err.message : 'The update command could not be run.';
  }

  setSetting(SETTINGS.autoUpdateLastResult, message);
  setSetting(SETTINGS.autoUpdateLastRun, String(Date.now()));
  return message;
}

/** Whether enough time has passed since the last run to do another. */
export function isDue(lastRunAt: number | null, now = Date.now()): boolean {
  return lastRunAt === null || now - lastRunAt >= INTERVAL_MS;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoUpdates(): void {
  if (timer) return;
  const tick = async () => {
    if (!getBoolSetting(SETTINGS.autoSecurityUpdates)) return;
    const lastRun = Number(getSetting(SETTINGS.autoUpdateLastRun) ?? '') || null;
    if (!isDue(lastRun)) return;
    await runSecurityUpdates().catch(() => undefined);
  };

  // Hourly, checking whether a day has passed, rather than a daily timer. A server
  // that is switched off overnight would never reach a daily one.
  timer = setInterval(() => void tick(), 60 * 60_000);
  timer.unref?.();
  void tick();
}

export function stopAutoUpdates(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
