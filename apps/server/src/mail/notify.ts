import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { checkUpdates, type UpdateItem } from '../system/updates.ts';
import { sendDirect } from './direct.ts';
import { lastDigest, mailAccount, mailSettings, markNotified } from './settings.ts';
import { type Mail, sendMail } from './smtp.ts';
import { htmlFor, subjectFor, textFor, type UpdateNotice } from './template.ts';

/**
 * Emailing about updates that are waiting.
 *
 * The hard part of a notifier is not sending: it is not sending. An email every day
 * saying the same three packages are still available is an email nobody reads by the
 * end of the week, which means the security one in the middle of next month goes
 * unread too. So this sends when the *set* of pending updates changes, and never more
 * than once a day.
 */

/** What is pending, reduced to something comparable between runs. */
export function digestOf(items: UpdateItem[]): string {
  const parts = items
    .map((item) => `${item.kind}:${item.id}:${item.available ?? ''}:${item.security ? 's' : ''}`)
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Where the dashboard lives, if it has been given a name. */
function dashboardUrl(): string | null {
  const domain = getSetting(SETTINGS.panelDomain);
  return domain ? `https://${domain}` : null;
}

export function noticeFor(items: UpdateItem[], rebootRequired: boolean): UpdateNotice {
  return {
    items,
    rebootRequired,
    dashboardUrl: dashboardUrl(),
    hostname: getSetting(SETTINGS.panelDomain) ?? hostname(),
  };
}

/**
 * Straight to the recipient's mail server, or through the relay that was set up.
 *
 * The one place that decides, so the daily notice and the "send a test" button
 * cannot end up taking different routes and disagreeing about whether it works.
 */
export async function deliver(account: ReturnType<typeof mailAccount>, mail: Mail): Promise<void> {
  if (!account) throw new Error('Nothing is set up to send with.');
  if (mailSettings().delivery === 'server') return sendDirect(account, mail);
  return sendMail(account, mail);
}

export type NotifyOutcome =
  | { sent: true; to: string; items: number }
  | {
      sent: false;
      reason: 'off' | 'not configured' | 'nothing pending' | 'already told you' | 'too soon';
    };

/** Twenty-three hours rather than twenty-four, so a daily run never skips a day. */
const MIN_GAP_MS = 23 * 60 * 60 * 1000;

export async function notifyAboutUpdates({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<NotifyOutcome> {
  const settings = mailSettings();
  if (!settings.notifyUpdates) return { sent: false, reason: 'off' };

  const account = mailAccount();
  const to = settings.notifyTo || settings.from;
  if (!account || !to) return { sent: false, reason: 'not configured' };

  const report = await checkUpdates();
  const items = settings.securityOnly ? report.items.filter((item) => item.security) : report.items;
  if (!items.length) return { sent: false, reason: 'nothing pending' };

  const digest = digestOf(items);
  if (!force && digest === lastDigest()) return { sent: false, reason: 'already told you' };
  if (!force && settings.lastSentAt && Date.now() - settings.lastSentAt < MIN_GAP_MS) {
    return { sent: false, reason: 'too soon' };
  }

  const notice = noticeFor(items, report.rebootRequired);
  await deliver(account, {
    to,
    subject: subjectFor(notice),
    text: textFor(notice),
    html: htmlFor(notice),
  });

  markNotified(digest);
  return { sent: true, to, items: items.length };
}

/**
 * One message, addressed to whoever is setting this up, to prove it works.
 *
 * Made from the updates that are really pending where there are any, because a test
 * that renders fake data does not tell you the real thing will render.
 */
export async function sendTestEmail(to: string): Promise<void> {
  const account = mailAccount();
  if (!account) {
    throw new Error('Fill in the mail server and the from address first.');
  }

  const report = await checkUpdates().catch(() => null);
  const items: UpdateItem[] = report?.items.length
    ? report.items
    : [
        {
          id: 'example',
          kind: 'derailed',
          name: 'Nothing is actually waiting',
          detail:
            'This is what the notice looks like. When something really is pending, it is listed here instead.',
          actionable: false,
        },
      ];

  const notice = noticeFor(items, report?.rebootRequired ?? false);
  await deliver(account, {
    to,
    subject: `Test: ${subjectFor(notice)}`,
    text: textFor(notice),
    html: htmlFor(notice),
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Checked hourly, sent at most daily. Hourly because the first notice about a
 * security update should not wait for an arbitrary time of day to come round.
 */
const INTERVAL_MS = 60 * 60 * 1000;

export function startUpdateNotifier(): void {
  if (timer) return;
  timer = setInterval(() => void notifyAboutUpdates().catch(() => undefined), INTERVAL_MS);
  timer.unref?.();
}

export function stopUpdateNotifier(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
