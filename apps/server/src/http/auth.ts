import type { User } from '@derailed/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  findSession,
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
  touchSession,
} from '../db/repo/sessions.ts';
import { TOKEN_PREFIX, verifyToken } from '../db/repo/tokens.ts';
import { findUserById, firstUser } from '../db/repo/users.ts';
import { forbidden, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'derailed_session';

export interface AppEnv {
  Variables: {
    user: User;
    sessionId: string;
  };
}

function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto.split(',')[0]!.trim() === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, sessionId: string, maxAgeMs = SESSION_TTL_MS): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c),
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Resolves the session cookie to a user, refreshing sliding expiry. */
export function currentUser(c: Context): User | null {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  const session = findSession(sessionId);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user) return null;
  if (session.expiresAt - Date.now() < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    touchSession(session.id);
    setSessionCookie(c, session.id);
  }
  return user;
}

/** Same check as `currentUser`, for places without a Hono context (the WS upgrade). */
export function userFromRequest(request: Request): User | null {
  const cookies = request.headers.get('cookie');
  if (!cookies) return null;
  const match = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const session = findSession(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)));
  if (!session) return null;
  return findUserById(session.userId);
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // An API token stands in for the admin, so coding agents and scripts can drive
  // Derailed without a browser session.
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer?.startsWith(TOKEN_PREFIX) && verifyToken(bearer)) {
    const owner = firstUser();
    if (!owner) throw unauthorized();
    c.set('user', owner);
    await next();
    return;
  }

  const user = currentUser(c);
  if (!user) throw unauthorized();
  c.set('user', user);
  c.set('sessionId', getCookie(c, SESSION_COOKIE)!);
  await next();
};

/**
 * Belt-and-suspenders CSRF: SameSite=Lax already blocks cross-site form posts, and a
 * custom header cannot be set cross-origin without a CORS preflight we never answer.
 */
export const requireCsrfHeader: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  // A bearer token cannot be attached by a browser on someone else's behalf, so
  // there is no cross-site request to forge and the header is unnecessary.
  const hasBearer = /^Bearer\s/i.test(c.req.header('authorization') ?? '');
  if (!hasBearer && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header('x-requested-with') !== 'derailed') {
      throw forbidden(
        'That request was blocked for safety.',
        'Reload the dashboard and try again.',
      );
    }
  }
  await next();
};

/** Small fixed-window limiter, enough for a single-admin panel. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'local';
}
