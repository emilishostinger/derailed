import { randomSecret } from '../../util/crypto.ts';
import { db } from '../index.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry: refresh the cookie once it is more than a day old. */
export const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export function createSession(userId: string): Session {
  const now = Date.now();
  const session: Session = {
    id: randomSecret(48),
    userId,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
  };
  db()
    .query('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(session.id, session.userId, session.expiresAt, session.createdAt);
  return session;
}

export function findSession(id: string): Session | null {
  const row = db().query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(id);
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function touchSession(id: string): number {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db().query('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id);
  return expiresAt;
}

export function deleteSession(id: string): void {
  db().query('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteSessionsForUser(userId: string): void {
  db().query('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function pruneExpiredSessions(): void {
  db().query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
