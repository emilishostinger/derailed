import type { AlertEventKind } from '@derailed/shared';
import { decrypt, encrypt } from '../../util/crypto.ts';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

/**
 * Places to tell when something happens.
 *
 * Not the same as the webhook alert *channel*, which posts the prose a human reads in
 * Discord. This is for wiring Derailed into something else: stable event names,
 * structured fields, every occurrence rather than a deduplicated one, and a signature.
 */
export interface Webhook {
  id: string;
  url: string;
  /** Whether a signing secret is stored. Never the secret itself. */
  hasSecret: boolean;
  /** Which events to send, or null for all of them. */
  events: AlertEventKind[] | null;
  enabled: boolean;
  createdAt: number;
  lastAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  secret_enc: string | null;
  events: string | null;
  enabled: 0 | 1;
  created_at: number;
  last_at: number | null;
  last_status: number | null;
  last_error: string | null;
}

const toWebhook = (row: WebhookRow): Webhook => ({
  id: row.id,
  url: row.url,
  hasSecret: row.secret_enc !== null,
  events: row.events ? (JSON.parse(row.events) as AlertEventKind[]) : null,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastAt: row.last_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
});

export function listWebhooks(): Webhook[] {
  return db()
    .query<WebhookRow, []>('SELECT * FROM webhooks ORDER BY created_at')
    .all()
    .map(toWebhook);
}

export function findWebhook(id: string): Webhook | null {
  const row = db().query<WebhookRow, [string]>('SELECT * FROM webhooks WHERE id = ?').get(id);
  return row ? toWebhook(row) : null;
}

/** The signing secret, decrypted. Only ever used to sign; never returned by the API. */
export function webhookSecret(id: string): string | null {
  const row = db()
    .query<{ secret_enc: string | null }, [string]>('SELECT secret_enc FROM webhooks WHERE id = ?')
    .get(id);
  if (!row?.secret_enc) return null;
  try {
    return decrypt(row.secret_enc);
  } catch {
    // A database restored without its key. Signing with a wrong secret would be worse
    // than not signing: the receiver would reject every delivery and never know why.
    return null;
  }
}

export function createWebhook(input: {
  url: string;
  secret?: string | null;
  events?: AlertEventKind[] | null;
}): Webhook {
  const id = newId();
  db()
    .query(
      'INSERT INTO webhooks (id, url, secret_enc, events, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run(
      id,
      input.url,
      input.secret?.trim() ? encrypt(input.secret.trim()) : null,
      input.events?.length ? JSON.stringify(input.events) : null,
      Date.now(),
    );
  return findWebhook(id)!;
}

export function updateWebhook(
  id: string,
  patch: { enabled?: boolean; events?: AlertEventKind[] | null },
): Webhook | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.enabled !== undefined) {
    assignments.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.events !== undefined) {
    assignments.push('events = ?');
    values.push(patch.events?.length ? JSON.stringify(patch.events) : null);
  }
  if (!assignments.length) return findWebhook(id);

  values.push(id);
  db()
    .query(`UPDATE webhooks SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return findWebhook(id);
}

export function deleteWebhook(id: string): void {
  db().query('DELETE FROM webhooks WHERE id = ?').run(id);
}

/** How the last delivery went, so the screen can say whether this works. */
export function recordDelivery(
  id: string,
  result: { status: number | null; error: string | null },
): void {
  db()
    .query('UPDATE webhooks SET last_at = ?, last_status = ?, last_error = ? WHERE id = ?')
    .run(Date.now(), result.status, result.error, id);
}
