import { db } from '../index.ts';

export function getSetting(key: string): string | null {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .query(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

export function deleteSetting(key: string): void {
  db().query('DELETE FROM settings WHERE key = ?').run(key);
}

export function getBoolSetting(key: string): boolean {
  return getSetting(key) === 'true';
}

export function setBoolSetting(key: string, value: boolean): void {
  setSetting(key, value ? 'true' : 'false');
}

/**
 * Wins the exclusive right to create the first account.
 *
 * Checking "is there an account yet?" and creating one are separated by reading the
 * request body and hashing a password, both of which yield. Two requests arriving
 * together therefore both saw an empty server, and both made an admin: whoever found
 * the server first got an account on it alongside its owner, and nothing about the
 * dashboard afterwards would say so.
 *
 * One statement, so SQLite settles it rather than us. The claim carries the time it
 * was taken and can be taken again once stale, or a process that died half way
 * through setup would leave a server nobody could ever create an account on.
 */
export function claimSetup(staleAfterMs = 60_000): boolean {
  const now = Date.now();
  const result = db()
    .query(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(settings.value AS INTEGER) < ?`,
    )
    .run(SETTINGS.setupClaim, String(now), now - staleAfterMs);
  return result.changes > 0;
}

/** Hands the claim back, so a setup that failed does not lock the server. */
export function releaseSetup(): void {
  deleteSetting(SETTINGS.setupClaim);
}

export const SETTINGS = {
  setupComplete: 'setup_complete',
  /** Held for the length of one setup request. See `claimSetup`. */
  setupClaim: 'setup_claim',
  serverIp: 'server_ip',
  serverIpSource: 'server_ip_source',
  panelDomain: 'panel_domain',
  appBaseDomain: 'app_base_domain',
  backupSchedule: 'backup_schedule',
  backupKeep: 'backup_keep',
  backupKeepDays: 'backup_keep_days',
  backupLastRun: 'backup_last_run',
} as const;
