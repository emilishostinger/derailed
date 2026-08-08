import type { Context } from 'hono';
import { db } from '../db/index.ts';
import { newId } from '../util/ids.ts';
import { resolveClientIp } from '../util/net.ts';
import { type AppEnv, peerAddress } from './auth.ts';

/**
 * Who did what.
 *
 * "Who deleted the database?" is impossible to answer retroactively and cheap to
 * answer in advance. On a one-person server it is a memory aid; the moment a second
 * person has access it is the difference between a conversation and an argument.
 *
 * Only writes are recorded. A log of every page somebody looked at would bury the
 * three lines that matter, and reading is not the thing anybody wonders about later.
 */

export interface AuditEntry {
  id: string;
  at: number;
  userId: string | null;
  email: string | null;
  action: string;
  subject: string | null;
  detail: string | null;
  ip: string | null;
}

/** Kept for a year. Long enough to answer "when did that change?" honestly. */
const KEEP_MS = 365 * 24 * 60 * 60 * 1000;

export function record(
  c: Context<AppEnv>,
  action: string,
  subject?: string | null,
  detail?: string | null,
): void {
  // Never throws. An audit line failing to write must not fail the thing it was
  // recording, which would be a strange way to lose a deploy.
  try {
    const user = c.get('user');
    db()
      .query(
        'INSERT INTO audit_log (id, at, user_id, email, action, subject, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId(),
        Date.now(),
        user?.id ?? null,
        user?.email ?? null,
        action,
        subject ?? null,
        detail ?? null,
        // The same trust rule as the rate limiter: `X-Forwarded-For` is only worth
        // reading when the socket itself is our own proxy, or anyone talking to
        // Derailed directly could stamp whatever source IP they liked onto their own
        // entry in the record of who did what.
        resolveClientIp(peerAddress(c), c.req.header('x-forwarded-for') ?? null),
      );
  } catch {
    // Nothing to do about it, and nothing worth breaking over.
  }
}

export function listAudit(limit = 200): AuditEntry[] {
  return db()
    .query<
      {
        id: string;
        at: number;
        user_id: string | null;
        email: string | null;
        action: string;
        subject: string | null;
        detail: string | null;
        ip: string | null;
      },
      [number]
    >('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      id: row.id,
      at: row.at,
      userId: row.user_id,
      email: row.email,
      action: row.action,
      subject: row.subject,
      detail: row.detail,
      ip: row.ip,
    }));
}

export function pruneAudit(now = Date.now()): number {
  return db()
    .query('DELETE FROM audit_log WHERE at < ?')
    .run(now - KEEP_MS).changes;
}

/**
 * Every write endpoint, recorded, without each one having to remember to.
 *
 * A middleware rather than a call in each handler: the handler that forgets is
 * exactly the one somebody will later wish had been recorded, and there is no way to
 * add it retroactively.
 */
export async function auditWrites(c: Context<AppEnv>, next: () => Promise<void>) {
  await next();

  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  // Only what actually happened. A refused request is not a change.
  if (!c.res || c.res.status >= 400) return;

  const path = new URL(c.req.url).pathname.replace(/^\/api/, '');
  record(c, `${method} ${path}`);
}
