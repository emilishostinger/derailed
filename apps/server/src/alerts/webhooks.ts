import { createHmac } from 'node:crypto';
import type { AlertEventKind } from '@derailed/shared';
import { listWebhooks, recordDelivery, webhookSecret } from '../db/repo/webhooks.ts';
import { newId } from '../util/ids.ts';

/**
 * Telling something else what happened.
 *
 * Deliberately not the webhook alert channel, which already exists and is a different
 * thing: that posts the prose a person reads in Discord, only fires for the alerts
 * somebody switched on, and is deduplicated so the same problem twice is said once.
 * All three of those are right for a human and wrong for a program.
 *
 * This is the machine-facing half: a stable event name, structured fields, every
 * occurrence, and a signature so the receiver can tell it really came from here.
 */

export interface WebhookEvent {
  event: AlertEventKind;
  /** What it is about: a service id, a project name, `the disk`. */
  subject: string;
  data: Record<string, unknown>;
}

/** How long to wait for the other end before giving up on one attempt. */
const TIMEOUT_MS = 10_000;
/** Two tries, then it is recorded as failed. A queue with retries is a bigger thing. */
const ATTEMPTS = 2;

/**
 * The signature a receiver checks.
 *
 * Over the exact body bytes, because anything else means the receiver has to
 * re-serialise the JSON identically to verify it, and no two languages agree on that.
 */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function deliver(
  webhook: { id: string; url: string },
  body: string,
  headers: Record<string, string>,
): Promise<void> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        recordDelivery(webhook.id, { status: response.status, error: null });
        return;
      }
      lastError = `answered ${response.status}`;
      // A 4xx is the receiver saying no, not a hiccup. Trying again just means two
      // rejections instead of one.
      if (response.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'could not be reached';
    }
    if (attempt < ATTEMPTS) await Bun.sleep(1000);
  }

  recordDelivery(webhook.id, { status: null, error: lastError });
}

/**
 * Sends one event everywhere that asked for it.
 *
 * Never awaited by the thing that raised the event, and never throws: a webhook
 * pointing at a machine that has been switched off must not slow down a deploy, and
 * must certainly not fail one.
 */
export function fire(event: WebhookEvent): void {
  const targets = listWebhooks().filter(
    (webhook) =>
      webhook.enabled && (webhook.events === null || webhook.events.includes(event.event)),
  );
  if (!targets.length) return;

  for (const webhook of targets) {
    // A fresh id per delivery rather than per event, so a receiver that sees the same
    // one twice knows it is a retry rather than two things happening.
    const delivery = newId();
    const body = JSON.stringify({
      event: event.event,
      subject: event.subject,
      at: Date.now(),
      delivery,
      data: event.data,
    });

    const secret = webhookSecret(webhook.id);
    const headers: Record<string, string> = {
      'x-derailed-event': event.event,
      'x-derailed-delivery': delivery,
      'user-agent': 'derailed',
    };
    if (secret) headers['x-derailed-signature'] = sign(secret, body);

    void deliver(webhook, body, headers);
  }
}
