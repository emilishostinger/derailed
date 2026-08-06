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
  /**
   * The free secured address, if one has been claimed. The name is the bare DuckDNS
   * label; the token is encrypted, like every other secret, and never sent back to
   * the browser. `freeDomainEmail` is only ever given to Let's Encrypt, so that an
   * expiry warning has somewhere to go.
   */
  freeDomainName: 'free_domain_name',
  freeDomainToken: 'free_domain_token_enc',
  freeDomainEmail: 'free_domain_email',
  /** When the certificate on disk stops being valid, cached for the dashboard. */
  freeDomainExpiresAt: 'free_domain_expires_at',
  /** Why the last attempt failed, so the settings page can say so rather than sulk. */
  freeDomainError: 'free_domain_error',
  backupSchedule: 'backup_schedule',
  backupKeep: 'backup_keep',
  backupKeepDays: 'backup_keep_days',
  backupLastRun: 'backup_last_run',
  /**
   * Off-site backups, to any S3-compatible provider. The secret is encrypted like
   * every other one and is never returned by the API.
   */
  offsiteEndpoint: 'offsite_endpoint',
  offsiteBucket: 'offsite_bucket',
  offsiteRegion: 'offsite_region',
  offsiteAccessKey: 'offsite_access_key',
  offsiteSecretKey: 'offsite_secret_key_enc',
  offsitePrefix: 'offsite_prefix',
  offsitePathStyle: 'offsite_path_style',
  offsiteLastCopyAt: 'offsite_last_copy_at',
  offsiteLastError: 'offsite_last_error',
  /**
   * Whether to take screenshots of the running sites. Off by default: it needs a
   * 300 MB browser image, which is not something to download without being asked.
   */
  previewShots: 'preview_shots',
  /** Where alerts go, and what is worth an alert. Secrets inside are encrypted. */
  alertChannels: 'alert_channels',
  alertEvents: 'alert_events',
  /** What has already been said recently, so the same thing is not said twice. */
  alertHistory: 'alert_history',
  /** A public page saying whether the sites are up. Off until asked for. */
  statusPageEnabled: 'status_page_enabled',
  statusPageTitle: 'status_page_title',
  /** The most recent restore drill, stored whole as JSON. */
  drillLast: 'drill_last',
} as const;
