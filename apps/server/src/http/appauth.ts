import type { Service } from '@derailed/shared';
import { db } from '../db/index.ts';
import {
  findUserByEmail,
  findUserById,
  setTotpLastStep,
  totpEnabled,
  totpLastStep,
  totpSecret,
  useRecoveryCode,
} from '../db/repo/users.ts';
import { escapeHtml } from '../mail/template.ts';
import { randomSecret } from '../util/crypto.ts';
import { newId } from '../util/ids.ts';
import { verifyCodeStep } from './totp.ts';

/**
 * Derailed accounts in front of any app.
 *
 * Password-protect puts one shared password on a site. This is the grown-up
 * version: a real login page on the app's own address, individual accounts, the
 * second factor if a person has one, and sessions that can be seen and ended.
 * The app itself is never touched; the proxy asks Derailed about each visitor,
 * and the answer is a cookie scoped to that app's own domain.
 *
 * Deliberately separate from dashboard sessions, twice over. Signing into the
 * photo app must not hand anybody the dashboard, so the cookie, the table and
 * the checks are all their own. And a viewer, who may not even open the
 * dashboard's terminal, may absolutely be the person the photo app is for.
 */

export const APP_SESSION_COOKIE = 'derailed_app';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AppSession {
  id: string;
  /** The cookie value. Never listed, never sent to the dashboard. */
  token: string;
  serviceId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  ip: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string;
  token: string;
  service_id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  ip: string | null;
  user_agent: string | null;
}

const toSession = (row: SessionRow): AppSession => ({
  id: row.id,
  token: row.token,
  serviceId: row.service_id,
  userId: row.user_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastSeenAt: row.last_seen_at,
  ip: row.ip,
  userAgent: row.user_agent,
});

export function createAppSession(
  serviceId: string,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): AppSession {
  const id = newId();
  const token = randomSecret(48);
  const now = Date.now();
  db()
    .query(
      `INSERT INTO app_sessions (id, token, service_id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, token, serviceId, userId, now, now + SESSION_TTL_MS, now, ip, userAgent);
  return findAppSession(token)!;
}

/** By the cookie's token, which is the only name a browser holds. */
export function findAppSession(token: string): AppSession | null {
  const row = db()
    .query<SessionRow, [string]>('SELECT * FROM app_sessions WHERE token = ?')
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db().query('DELETE FROM app_sessions WHERE id = ?').run(row.id);
    return null;
  }
  return toSession(row);
}

export function touchAppSession(id: string): void {
  db().query('UPDATE app_sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

export function listAppSessions(serviceId: string): (AppSession & { email: string })[] {
  return db()
    .query<SessionRow & { email: string }, [string, number]>(
      `SELECT s.*, u.email FROM app_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.service_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`,
    )
    .all(serviceId, Date.now())
    .map((row) => ({ ...toSession(row), email: row.email }));
}

/** By the dashboard's id, which names a session without being one. */
export function deleteAppSession(serviceId: string, id: string): boolean {
  const row = db()
    .query<{ id: string; service_id: string }, [string]>(
      'SELECT id, service_id FROM app_sessions WHERE id = ?',
    )
    .get(id);
  if (!row || row.service_id !== serviceId) return false;
  db().query('DELETE FROM app_sessions WHERE id = ?').run(id);
  return true;
}

/** Whoever the cookie speaks for, if it still speaks for anyone allowed in. */
export function appSessionUser(
  service: Service,
  cookieValue: string | null | undefined,
): { userId: string; email: string } | null {
  if (!cookieValue) return null;
  const session = findAppSession(cookieValue);
  if (!session || session.serviceId !== service.id) return null;
  const user = findUserById(session.userId);
  if (!user) return null;
  if (!emailAllowed(service, user.email)) return null;
  touchAppSession(session.id);
  return { userId: user.id, email: user.email };
}

/** Whether this address is on the list, or the list is "anyone with an account". */
export function emailAllowed(service: Service, email: string): boolean {
  const allowed = service.allowedEmails;
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((entry) => entry.toLowerCase() === email.toLowerCase());
}

export type AppLoginOutcome =
  | { ok: true; userId: string }
  | { ok: false; needsCode: boolean; message: string };

/**
 * The same two factors the dashboard checks, against the same accounts, with the
 * same replay rule for codes. What differs is only what a success buys: a cookie
 * for one app's domain, never a dashboard.
 */
export async function checkAppLogin(
  service: Service,
  email: string,
  password: string,
  code: string,
): Promise<AppLoginOutcome> {
  const record = findUserByEmail(email);
  // A malformed hash in the row must read as a mismatch, not a server error: this
  // page faces the internet, and a 500 here is both a worse experience and a
  // louder signal than a plain refusal.
  const ok = await Bun.password
    .verify(password, record?.passwordHash ?? (await decoyHash()))
    .catch(() => false);
  if (!record || !ok) {
    return { ok: false, needsCode: false, message: 'That email and password do not match.' };
  }
  if (!emailAllowed(service, record.email)) {
    // Said plainly. The person has a real account; hiding which list they are
    // not on helps nobody who is supposed to be here.
    return {
      ok: false,
      needsCode: false,
      message: 'Your account is not on the list for this site. Ask whoever runs it.',
    };
  }

  if (totpEnabled(record.id)) {
    const supplied = code.trim();
    if (!supplied) {
      return { ok: false, needsCode: true, message: '' };
    }
    let authed = false;
    const secret = totpSecret(record.id);
    if (secret) {
      const step = verifyCodeStep(secret, supplied);
      if (step !== null) {
        const last = totpLastStep(record.id);
        if (last !== null && step <= last) {
          return {
            ok: false,
            needsCode: true,
            message: 'That code has already been used. Wait for the next one.',
          };
        }
        setTotpLastStep(record.id, step);
        authed = true;
      }
    }
    if (!authed && useRecoveryCode(record.id, supplied)) authed = true;
    if (!authed) return { ok: false, needsCode: true, message: 'That code is not right.' };
  }

  return { ok: true, userId: record.id };
}

let decoy: string | null = null;
async function decoyHash(): Promise<string> {
  if (!decoy) decoy = await Bun.password.hash(randomSecret(24), { algorithm: 'bcrypt', cost: 12 });
  return decoy;
}

/** A path on the same site, or the front page. Never somebody else's site. */
export function safeReturnPath(value: string | null | undefined): string {
  const target = value?.trim();
  if (!target?.startsWith('/') || target.startsWith('//')) return '/';
  if (target.startsWith('/__derailed/')) return '/';
  return target;
}

/**
 * The login page, on the app's own address. Server-rendered, no dependencies,
 * same family as the status and holding pages.
 */
export function loginPage(options: {
  serviceName: string;
  returnTo: string;
  needsCode?: boolean;
  email?: string;
  message?: string;
}): string {
  const { serviceName, returnTo, needsCode, email, message } = options;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;color:#1c1b22;background:#faf9fb;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{width:100%;max-width:20rem}
  h1{font-size:1.25rem;margin:0 0 .25rem}
  p{margin:0 0 1rem;color:#5b5a66;font-size:.9rem}
  label{display:block;font-size:.8rem;color:#5b5a66;margin:0 0 .25rem}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.5rem .65rem;margin:0 0 .8rem;
        border:1px solid #d6d4de;border-radius:8px;background:#fff;color:inherit}
  button{width:100%;font:inherit;font-weight:600;padding:.55rem;border:0;border-radius:8px;
         background:#1c1b22;color:#fff;cursor:pointer}
  .err{color:#b3261e;font-size:.85rem;margin:0 0 .8rem}
  @media(prefers-color-scheme:dark){
    body{color:#eceaf2;background:#131218}
    p,label{color:#a6a3b3}
    input{background:#1c1b24;border-color:#37343f}
    button{background:#eceaf2;color:#131218}
  }
</style></head>
<body><main>
<h1>${escapeHtml(serviceName)}</h1>
<p>Sign in with your account for this server.</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/__derailed/auth/login">
  <input type="hidden" name="to" value="${escapeHtml(returnTo)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email ?? '')}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${
    needsCode
      ? `<label for="code">The six-digit code from your authenticator app</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>`
      : ''
  }
  <button type="submit">Sign in</button>
</form>
</main></body></html>`;
}
