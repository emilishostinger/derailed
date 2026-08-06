import { getSetting, setSetting } from '../db/repo/settings.ts';
import { decrypt, encrypt } from '../util/crypto.ts';
import { isEmailAddress, type MailAccount, type MailSecurity } from './smtp.ts';

/**
 * Where update notices go, and how they get there.
 *
 * Kept in settings rather than in a config file, because the person setting this up
 * is looking at the dashboard, not at the server. The password is encrypted with the
 * same key as everything else at rest and is never sent back out.
 */
const KEYS = {
  host: 'mail_host',
  port: 'mail_port',
  security: 'mail_security',
  username: 'mail_username',
  password: 'mail_password_enc',
  from: 'mail_from',
  fromName: 'mail_from_name',
  notify: 'notify_updates',
  notifyTo: 'notify_updates_to',
  securityOnly: 'notify_updates_security_only',
  lastSent: 'notify_updates_last_sent',
  lastDigest: 'notify_updates_last_digest',
} as const;

export interface MailSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** Never the password itself. The dashboard only ever needs to know it is there. */
  hasPassword: boolean;
  from: string;
  fromName: string;
  /** Whether to email about pending updates at all. */
  notifyUpdates: boolean;
  notifyTo: string;
  /** Only email when something is a security update, rather than for every one. */
  securityOnly: boolean;
  lastSentAt: number | null;
}

const DEFAULT_PORTS: Record<MailSecurity, number> = { tls: 465, starttls: 587, none: 25 };

export function mailSettings(): MailSettings {
  const security = (getSetting(KEYS.security) ?? 'starttls') as MailSecurity;
  const port = Number(getSetting(KEYS.port));
  const lastSent = getSetting(KEYS.lastSent);

  return {
    host: getSetting(KEYS.host) ?? '',
    port: Number.isFinite(port) && port > 0 ? port : (DEFAULT_PORTS[security] ?? 587),
    security,
    username: getSetting(KEYS.username) ?? '',
    // Truthiness, not `!== null`. Clearing the password writes an empty string
    // rather than deleting the row, and an empty string is not null, so the
    // settings page went on saying "one is saved" about a password that was gone.
    hasPassword: Boolean(getSetting(KEYS.password)),
    from: getSetting(KEYS.from) ?? '',
    fromName: getSetting(KEYS.fromName) ?? 'Derailed',
    notifyUpdates: getSetting(KEYS.notify) === 'true',
    notifyTo: getSetting(KEYS.notifyTo) ?? '',
    securityOnly: getSetting(KEYS.securityOnly) === 'true',
    lastSentAt: lastSent ? Number(lastSent) : null,
  };
}

export interface MailSettingsPatch {
  host?: string;
  port?: number;
  security?: MailSecurity;
  username?: string;
  /** Empty string clears the stored password; undefined leaves it alone. */
  password?: string;
  from?: string;
  fromName?: string;
  notifyUpdates?: boolean;
  notifyTo?: string;
  securityOnly?: boolean;
}

export function saveMailSettings(patch: MailSettingsPatch): MailSettings {
  if (patch.host !== undefined) setSetting(KEYS.host, patch.host.trim());
  if (patch.port !== undefined) setSetting(KEYS.port, String(patch.port));
  if (patch.security !== undefined) setSetting(KEYS.security, patch.security);
  if (patch.username !== undefined) setSetting(KEYS.username, patch.username.trim());
  if (patch.from !== undefined) setSetting(KEYS.from, patch.from.trim());
  if (patch.fromName !== undefined) setSetting(KEYS.fromName, patch.fromName.trim());
  if (patch.notifyUpdates !== undefined) setSetting(KEYS.notify, String(patch.notifyUpdates));
  if (patch.notifyTo !== undefined) setSetting(KEYS.notifyTo, patch.notifyTo.trim());
  if (patch.securityOnly !== undefined) setSetting(KEYS.securityOnly, String(patch.securityOnly));

  // An empty password field means "no password", not "leave it as it was". The
  // dashboard never receives the stored one, so it cannot send it back unchanged.
  if (patch.password !== undefined) {
    if (patch.password === '') setSetting(KEYS.password, '');
    else setSetting(KEYS.password, encrypt(patch.password));
  }

  return mailSettings();
}

export function mailPassword(): string | null {
  const stored = getSetting(KEYS.password);
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    // The key changed underneath it. Better no password than a corrupt one.
    return null;
  }
}

/** The account to send with, or null when it is not set up enough to try. */
export function mailAccount(): MailAccount | null {
  const settings = mailSettings();
  if (!settings.host.trim() || !isEmailAddress(settings.from)) return null;
  return {
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username || null,
    password: mailPassword(),
    from: settings.from,
    fromName: settings.fromName || null,
  };
}

export function markNotified(digest: string): void {
  setSetting(KEYS.lastSent, String(Date.now()));
  setSetting(KEYS.lastDigest, digest);
}

export function lastDigest(): string | null {
  return getSetting(KEYS.lastDigest);
}
