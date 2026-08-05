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

export const SETTINGS = {
  setupComplete: 'setup_complete',
  serverIp: 'server_ip',
  serverIpSource: 'server_ip_source',
  panelDomain: 'panel_domain',
  appBaseDomain: 'app_base_domain',
  backupSchedule: 'backup_schedule',
  backupKeep: 'backup_keep',
  backupKeepDays: 'backup_keep_days',
  backupLastRun: 'backup_last_run',
} as const;
