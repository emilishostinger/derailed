import { createHash } from 'node:crypto';
import type { AlertChannel, AlertEventKind, AlertSettings } from '@derailed/shared';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { decrypt, encrypt } from '../util/crypto.ts';
import { type Alert, type Channel, deliver } from './channels.ts';
import { fire } from './webhooks.ts';

/**
 * Deciding when to say something.
 *
 * The hard part of a notifier is not sending, it is not sending. An alert every time
 * a container restarts is an alert nobody reads by Thursday, which means the one that
 * mattered on Friday goes unread too. The update emails already worked this out and
 * this follows the same rule: something is said when the *situation changes*, and the
 * same situation is never reported twice.
 *
 * Every message carries what happened, what it means, and what to do. A notification
 * that says "container exited" and stops is a notification that made your phone buzz
 * and left you no better off.
 */

/** How long the same problem stays quiet after being reported once. */
const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;

interface Reported {
  /** Fingerprint of the situation, not of the message. */
  key: string;
  at: number;
}

function history(): Reported[] {
  try {
    return JSON.parse(getSetting(SETTINGS.alertHistory) ?? '[]') as Reported[];
  } catch {
    return [];
  }
}

function remember(entries: Reported[]): void {
  // Only the recent past matters, and this lives in a settings row rather than a
  // table. Trimmed so it cannot grow without bound on a busy server.
  const cutoff = Date.now() - REPEAT_AFTER_MS * 4;
  setSetting(
    SETTINGS.alertHistory,
    JSON.stringify(entries.filter((entry) => entry.at > cutoff).slice(-200)),
  );
}

export function fingerprint(kind: AlertEventKind, subject: string, detail = ''): string {
  return createHash('sha256').update(`${kind}|${subject}|${detail}`).digest('hex').slice(0, 24);
}

/** Whether this exact situation has already been reported recently. */
export function alreadySaid(key: string, now = Date.now()): boolean {
  const entry = history().find((item) => item.key === key);
  return entry !== undefined && now - entry.at < REPEAT_AFTER_MS;
}

/**
 * Notes that something is better now, so the next occurrence is reported again.
 *
 * Without this, an app that crashes, is fixed, and crashes again six hours later
 * would be silent the second time, which is the failure mode that makes people stop
 * trusting alerts entirely.
 */
export function clearAlert(key: string): void {
  remember(history().filter((entry) => entry.key !== key));
}

export function alertSettings(): AlertSettings {
  let channels: AlertChannel[] = [];
  try {
    channels = JSON.parse(getSetting(SETTINGS.alertChannels) ?? '[]') as AlertChannel[];
  } catch {
    channels = [];
  }
  return {
    // Secrets never leave the server, same as everywhere else.
    channels: channels.map((channel) => ({ ...channel, secret: channel.secret ? '' : null })),
    events: enabledEvents(),
  };
}

function storedChannels(): (AlertChannel & { secret: string | null })[] {
  try {
    const raw = JSON.parse(getSetting(SETTINGS.alertChannels) ?? '[]') as AlertChannel[];
    return raw.map((channel) => ({
      ...channel,
      secret: channel.secret ? safeDecrypt(channel.secret) : null,
    }));
  } catch {
    return [];
  }
}

function safeDecrypt(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

export function saveChannels(channels: AlertChannel[]): AlertSettings {
  const existing = storedChannels();
  const prepared = channels.map((channel) => {
    // A blank secret means "keep the one already saved", so editing the form without
    // retyping a bot token does not silently wipe it.
    const previous = existing.find((entry) => entry.id === channel.id);
    const secret = channel.secret?.trim() ? channel.secret.trim() : previous?.secret;
    return { ...channel, secret: secret ? encrypt(secret) : null };
  });
  setSetting(SETTINGS.alertChannels, JSON.stringify(prepared));
  return alertSettings();
}

/** Every kind of thing worth being told about, and whether it is switched on. */
export const ALL_EVENTS: { kind: AlertEventKind; label: string; onByDefault: boolean }[] = [
  { kind: 'app.crashed', label: 'An app crashes', onByDefault: true },
  { kind: 'app.crashloop', label: 'An app keeps crashing', onByDefault: true },
  { kind: 'deploy.failed', label: 'A deploy fails', onByDefault: true },
  { kind: 'disk.low', label: 'The disk is filling up', onByDefault: true },
  { kind: 'memory.low', label: 'Memory is running out', onByDefault: true },
  { kind: 'certificate.expiring', label: 'A certificate is about to expire', onByDefault: true },
  { kind: 'domain.drifted', label: 'A domain stops pointing here', onByDefault: true },
  { kind: 'backup.failed', label: 'A backup fails', onByDefault: true },
  { kind: 'drill.failed', label: 'A backup turns out not to restore', onByDefault: true },
  { kind: 'job.failed', label: 'A scheduled job fails', onByDefault: true },
  { kind: 'deploy.succeeded', label: 'A deploy works', onByDefault: false },
];

export function enabledEvents(): AlertEventKind[] {
  const stored = getSetting(SETTINGS.alertEvents);
  if (stored === null) {
    return ALL_EVENTS.filter((event) => event.onByDefault).map((event) => event.kind);
  }
  try {
    return JSON.parse(stored) as AlertEventKind[];
  } catch {
    return ALL_EVENTS.filter((event) => event.onByDefault).map((event) => event.kind);
  }
}

export function saveEvents(events: AlertEventKind[]): AlertSettings {
  setSetting(SETTINGS.alertEvents, JSON.stringify(events));
  return alertSettings();
}

function dashboardUrl(): string | null {
  const domain = getSetting(SETTINGS.panelDomain);
  return domain ? `https://${domain}` : null;
}

export interface RaiseOptions extends Alert {
  kind: AlertEventKind;
  /** What this is about: an app name, a domain, "the disk". Part of the fingerprint. */
  subject: string;
  /** Distinguishes one occurrence from another of the same thing, when it should. */
  detail?: string;
  /** Send even if the same thing was reported recently. Only for tests and buttons. */
  force?: boolean;
}

export interface RaiseResult {
  sent: number;
  failed: { channel: string; reason: string }[];
  skipped: 'off' | 'no channels' | 'already said' | null;
}

/**
 * Says something, once, to everywhere that is set up.
 *
 * Failures are collected rather than thrown: one broken Discord webhook must not stop
 * the same alert reaching the phone.
 */
export async function raise(options: RaiseOptions): Promise<RaiseResult> {
  const result: RaiseResult = { sent: 0, failed: [], skipped: null };

  /**
   * Outbound webhooks go first, and unconditionally.
   *
   * Every one of the three checks below is a decision about what a person wants to
   * be told: whether this kind of alert is switched on, whether any channel exists,
   * and whether the same thing was said recently. None of them is true of a program
   * wired into this, which wants every occurrence whatever anybody has switched on.
   *
   * Hung off `raise` rather than off eleven call sites because this is already the
   * funnel every notable event goes through, and the twelfth call site is the one
   * somebody would forget.
   */
  fire({
    event: options.kind,
    subject: options.subject,
    data: {
      title: options.title,
      body: options.body,
      action: options.action ?? null,
      severity: options.severity,
      url: options.url ?? dashboardUrl(),
    },
  });

  if (!enabledEvents().includes(options.kind)) {
    result.skipped = 'off';
    return result;
  }

  const channels = storedChannels();
  if (!channels.length) {
    result.skipped = 'no channels';
    return result;
  }

  const key = fingerprint(options.kind, options.subject, options.detail);
  if (!options.force && alreadySaid(key)) {
    result.skipped = 'already said';
    return result;
  }

  const alert: Alert = {
    title: options.title,
    body: options.body,
    action: options.action,
    severity: options.severity,
    url: options.url ?? dashboardUrl(),
  };

  for (const channel of channels) {
    try {
      await deliver(channel as Channel, alert);
      result.sent++;
    } catch (err) {
      result.failed.push({
        channel: channel.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Recorded even when every channel failed. Otherwise a broken webhook would mean
  // the same alert retried every few seconds for as long as the problem lasted.
  if (!options.force)
    remember([...history().filter((e) => e.key !== key), { key, at: Date.now() }]);

  return result;
}

/** Sends one alert to one channel, ignoring every rule. For the Test button. */
export async function testChannel(channelId: string): Promise<void> {
  const channel = storedChannels().find((entry) => entry.id === channelId);
  if (!channel) throw new Error('That channel no longer exists.');

  await deliver(channel as Channel, {
    title: 'Derailed is set up correctly',
    body: 'This is a test. If you are reading it, alerts from this server will reach you here.',
    severity: 'info',
    url: dashboardUrl(),
  });
}
