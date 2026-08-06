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
import { resolveClientIp, resolveHttps } from '../util/net.ts';
import { forbidden, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'derailed_session';

/** What Bun's `requestIP` gives us, handed to Hono as the binding in `serve.ts`. */
export interface AppBindings {
  ip?: { address: string; family: string; port: number } | null;
}

export interface AppEnv {
  Bindings: AppBindings;
  Variables: {
    user: User;
    sessionId: string;
  };
}

/** The socket address, when the adapter gave us one. */
export function peerAddress(c: Context): string | null {
  return (c.env as AppBindings | undefined)?.ip?.address ?? null;
}

function isHttps(c: Context): boolean {
  return resolveHttps(
    peerAddress(c),
    c.req.header('x-forwarded-proto') ?? null,
    new URL(c.req.url).protocol,
  );
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

/**
 * Whether a websocket handshake came from the dashboard itself.
 *
 * The REST API is safe from a page on another site because every call carries a
 * header a browser will not send cross-origin without a preflight we never answer.
 * A websocket has no such handshake: `new WebSocket(...)` is exempt from CORS
 * entirely, so the only thing standing between a hostile page and this socket is the
 * cookie, and `SameSite=Lax` separates *sites*, not origins.
 *
 * That distinction is the whole problem here. Derailed's own dashboard sits on
 * `panel.example.com` and the apps it deploys sit on `app.example.com`, which is the
 * same site. So an app someone deployed, running code they did not write, could open
 * a socket to `/api/terminal` with the admin's cookie riding along and get a shell in
 * any container on the machine. Hence: the handshake has to come from us.
 *
 * A request with no `Origin` at all is allowed. Browsers always send one on a
 * websocket handshake; a script that does not is not a browser, so there is no
 * session for it to be riding on and nothing to forge.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  const host = request.headers.get('host');
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    // Not a URL. `null` is what a sandboxed frame sends, and it is not us.
    return false;
  }
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

/**
 * Who to hold a rate limit against.
 *
 * Deliberately not `X-Forwarded-For` on its own. That header is written by whoever is
 * calling, so keying on it meant an attacker could make every password guess look like
 * a different person and never meet the limiter at all. See `util/net.ts`.
 */
export function clientIp(c: Context): string {
  return resolveClientIp(peerAddress(c), c.req.header('x-forwarded-for') ?? null);
}
