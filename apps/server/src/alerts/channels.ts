import type { AlertChannelKind } from '@derailed/shared';
import { sendDirect } from '../mail/direct.ts';
import { mailAccount, mailSettings } from '../mail/settings.ts';
import { sendMail } from '../mail/smtp.ts';

/**
 * Where an alert goes.
 *
 * One shape for every destination, because the interesting part of this feature is
 * deciding *when* to say something, and that decision should not have to know whether
 * it is talking to Slack or to a phone.
 *
 * The list is the places people running a small server actually are. ntfy is on it
 * because it is the only one that puts a notification on a phone for free with no
 * account anywhere, which for a hobby server is exactly right.
 */

export interface Alert {
  /** One line. Shows up as the notification title, or the email subject. */
  title: string;
  /** A sentence or two saying what happened and what it means. */
  body: string;
  /** What to do about it, when there is something. */
  action?: string;
  severity: 'info' | 'warning' | 'critical';
  /** Where to go to deal with it, when the dashboard has an address. */
  url?: string | null;
}

export interface Channel {
  kind: AlertChannelKind;
  /** A webhook URL, an ntfy topic URL, a Telegram chat, or an email address. */
  target: string;
  /** Telegram needs a bot token as well as a chat id. */
  secret?: string | null;
}

const TIMEOUT_MS = 10_000;

function plainText(alert: Alert): string {
  return [alert.body, alert.action, alert.url].filter(Boolean).join('\n\n');
}

/** Discord and Slack both take a colour; the rest ignore it. */
function colourFor(severity: Alert['severity']): number {
  if (severity === 'critical') return 0xef4444;
  if (severity === 'warning') return 0xeab308;
  return 0x7236e3;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`${response.status} ${response.statusText}. ${detail}`.trim());
  }
}

/**
 * Sends one alert to one place.
 *
 * Throws on failure so the caller can record it. Alerts are not important enough to
 * retry hard, and a channel that is broken should be visible in settings rather than
 * silently swallowing everything.
 */
export async function deliver(channel: Channel, alert: Alert): Promise<void> {
  switch (channel.kind) {
    case 'discord':
      return post(channel.target, {
        embeds: [
          {
            title: alert.title,
            description: plainText(alert),
            color: colourFor(alert.severity),
          },
        ],
      });

    case 'slack':
      return post(channel.target, {
        text: alert.title,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: alert.title.slice(0, 150) } },
          { type: 'section', text: { type: 'mrkdwn', text: plainText(alert) } },
        ],
      });

    case 'telegram': {
      if (!channel.secret) throw new Error('That Telegram channel has no bot token.');
      // `sendMessage` with plain text rather than any markup: an app's error output
      // is arbitrary and Telegram rejects the whole message on malformed markdown.
      return post(`https://api.telegram.org/bot${channel.secret}/sendMessage`, {
        chat_id: channel.target,
        text: `${alert.title}\n\n${plainText(alert)}`,
        disable_web_page_preview: true,
      });
    }

    case 'ntfy':
      // ntfy takes the body as the request body and everything else as headers, which
      // is why this one is not JSON.
      return post(channel.target, alert.body, {
        'content-type': 'text/plain; charset=utf-8',
        Title: asciiHeader(alert.title),
        Priority: alert.severity === 'critical' ? '5' : alert.severity === 'warning' ? '4' : '3',
        Tags: alert.severity === 'critical' ? 'rotating_light' : 'warning',
        ...(alert.url ? { Click: alert.url } : {}),
      });

    case 'webhook':
      // Everything, in the shape it was decided in, for anyone wiring this into
      // something of their own.
      return post(channel.target, {
        title: alert.title,
        body: alert.body,
        action: alert.action ?? null,
        severity: alert.severity,
        url: alert.url ?? null,
        at: Date.now(),
      });

    case 'email': {
      const account = mailAccount();
      if (!account) throw new Error('Nothing is set up to send email with.');
      const mail = {
        to: channel.target,
        subject: alert.title,
        text: plainText(alert),
        html: emailHtml(alert),
      };
      return mailSettings().delivery === 'server'
        ? sendDirect(account, mail)
        : sendMail(account, mail);
    }

    default:
      throw new Error(`Derailed does not know how to send to ${channel.kind}.`);
  }
}

/**
 * HTTP headers may only carry Latin-1, and an app's name can carry anything at all.
 * Sending a title with an emoji in it fails the whole request, which would be a
 * confusing way to lose an alert about something else.
 */
function asciiHeader(value: string): string {
  return value.replace(/[^\u0020-\u007E]/g, '').slice(0, 200) || 'Derailed';
}

function emailHtml(alert: Alert): string {
  const safe = (text: string) =>
    text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char);

  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p style="margin:0 0 12px;font-weight:600">${safe(alert.title)}</p>
  <p style="margin:0 0 12px">${safe(alert.body)}</p>
  ${alert.action ? `<p style="margin:0 0 12px;color:#555">${safe(alert.action)}</p>` : ''}
  ${alert.url ? `<p style="margin:0"><a href="${safe(alert.url)}">Open the dashboard</a></p>` : ''}
</div>`;
}

/**
 * What a channel looks like when it is set up correctly, for the settings page.
 *
 * Each of these is the thing people get wrong: a Slack URL pasted into the Discord
 * box, an ntfy topic name rather than its address, a Telegram chat id left blank.
 */
export function describeChannel(kind: AlertChannelKind): { label: string; hint: string } {
  switch (kind) {
    case 'discord':
      return {
        label: 'Discord',
        hint: 'Server Settings, Integrations, Webhooks, New Webhook, then Copy Webhook URL.',
      };
    case 'slack':
      return {
        label: 'Slack',
        hint: 'An Incoming Webhook URL, which starts https://hooks.slack.com/services/.',
      };
    case 'telegram':
      return {
        label: 'Telegram',
        hint: 'Your chat id, and the token @BotFather gave you when you made the bot.',
      };
    case 'ntfy':
      return {
        label: 'Phone notification (ntfy)',
        hint: 'The full address of your topic, e.g. https://ntfy.sh/my-server-a7f2. Install the ntfy app and subscribe to the same one. Free, and no account needed.',
      };
    case 'webhook':
      return { label: 'Anything else', hint: 'A URL. Derailed posts JSON to it.' };
    case 'email':
      return {
        label: 'Email',
        hint: 'Uses the mail settings further down this page.',
      };
  }
}
