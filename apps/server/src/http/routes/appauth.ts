import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.ts';
import { findService } from '../../db/repo/services.ts';
import { emitService } from '../../runtime/present.ts';
import {
  APP_SESSION_COOKIE,
  appSessionUser,
  checkAppLogin,
  createAppSession,
  deleteAppSession,
  listAppSessions,
  loginPage,
  safeReturnPath,
} from '../appauth.ts';
import type { AppEnv } from '../auth.ts';
import { RateLimiter } from '../auth.ts';
import { notFound, parseBody } from '../errors.ts';

/**
 * One login in front of any app: the three endpoints the proxy sends an app's
 * visitors through, and the dashboard's view of who is signed in.
 *
 * The public half lives on the app's own address (the proxy rewrites
 * /__derailed/auth/* here), so the cookie a sign-in earns belongs to that
 * domain and no other. The check endpoint is what Caddy's forward-auth asks
 * before every request: 200 means carry on to the app, anything else is shown
 * to the visitor instead, which is how the login page appears.
 */

export const publicAppAuthRoutes = new Hono();
export const appLoginRoutes = new Hono<AppEnv>();

const loginLimiter = new RateLimiter(5, 60_000);

function requestedService(header: string | undefined) {
  const service = findService(header ?? '');
  if (service?.kind !== 'app' || !service.loginRequired) return null;
  return service;
}

function cookieValue(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === APP_SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

function setSessionCookie(secure: boolean, value: string, maxAgeSeconds: number): string {
  return [
    `${APP_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** What Caddy asks before every request: may this visitor through? */
publicAppAuthRoutes.get('/appauth/check', (c) => {
  const service = requestedService(c.req.header('x-derailed-service'));
  if (!service) return c.body(null, 200);

  const user = appSessionUser(service, cookieValue(c.req.header('cookie')));
  if (user) {
    c.header('X-Derailed-User', user.email);
    return c.body(null, 200);
  }

  const wanted = safeReturnPath(c.req.header('x-forwarded-uri'));
  return c.redirect(`/__derailed/auth/login?to=${encodeURIComponent(wanted)}`, 303);
});

/** The login page itself, on the app's own address. */
publicAppAuthRoutes.get('/appauth/login', (c) => {
  const service = requestedService(c.req.header('x-derailed-service'));
  if (!service) return c.text('Nothing to sign in to here.', 404);
  const returnTo = safeReturnPath(c.req.query('to'));

  // Already signed in? Straight back to what they wanted.
  if (appSessionUser(service, cookieValue(c.req.header('cookie')))) {
    return c.redirect(returnTo, 303);
  }
  return c.html(loginPage({ serviceName: service.name, returnTo }));
});

publicAppAuthRoutes.post('/appauth/login', async (c) => {
  const service = requestedService(c.req.header('x-derailed-service'));
  if (!service) return c.text('Nothing to sign in to here.', 404);

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const form = await c.req.raw.formData().catch(() => null);
  const email = String(form?.get('email') ?? '').trim();
  const password = String(form?.get('password') ?? '');
  const code = String(form?.get('code') ?? '');
  const returnTo = safeReturnPath(String(form?.get('to') ?? ''));

  const render = (message: string, needsCode: boolean, status: 200 | 401 | 429 = 401) =>
    c.html(loginPage({ serviceName: service.name, returnTo, needsCode, email, message }), status);

  if (!loginLimiter.check(`${service.id}:${ip ?? 'unknown'}`)) {
    return render('Too many attempts. Wait a minute before trying again.', false, 429);
  }
  if (!email || !password) return render('Both the email and the password are needed.', false);

  const outcome = await checkAppLogin(service, email, password, code);
  if (!outcome.ok) {
    if (outcome.needsCode && !outcome.message) {
      // The password was right; the browser just needs to know to ask for the code.
      return render('', true, 200);
    }
    return render(outcome.message, outcome.needsCode);
  }

  loginLimiter.reset(`${service.id}:${ip ?? 'unknown'}`);
  const session = createAppSession(
    service.id,
    outcome.userId,
    ip,
    c.req.header('user-agent') ?? null,
  );
  const secure = (c.req.header('x-forwarded-proto') ?? '') === 'https';
  c.header('Set-Cookie', setSessionCookie(secure, session.token, 30 * 24 * 60 * 60));
  return c.redirect(returnTo, 303);
});

/** Signs this browser out of this app, and only this app. */
publicAppAuthRoutes.get('/appauth/logout', (c) => {
  const service = requestedService(c.req.header('x-derailed-service'));
  const value = cookieValue(c.req.header('cookie'));
  if (service && value) {
    db()
      .query('DELETE FROM app_sessions WHERE token = ? AND service_id = ?')
      .run(value, service.id);
  }
  const secure = (c.req.header('x-forwarded-proto') ?? '') === 'https';
  c.header('Set-Cookie', setSessionCookie(secure, '', 0));
  return c.redirect('/', 303);
});

// ---------------------------------------------------------------------------
// The dashboard's half.
// ---------------------------------------------------------------------------

/** Who can open this app, and who is signed in right now. */
appLoginRoutes.get('/:id/login', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  return c.json({
    loginRequired: !!service.loginRequired,
    allowedEmails: service.allowedEmails ?? [],
    sessions: listAppSessions(service.id).map((session) => ({
      id: session.id,
      email: session.email,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      ip: session.ip,
      userAgent: session.userAgent,
    })),
  });
});

appLoginRoutes.put('/:id/login', async (c) => {
  const service = findService(c.req.param('id'));
  if (service?.kind !== 'app') throw notFound('That app');
  const body = await parseBody(c, schemas.appLoginRequest);

  db()
    .query(
      'UPDATE services SET login_required = ?, allowed_emails = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      body.enabled ? 1 : 0,
      body.allowedEmails?.length ? JSON.stringify(body.allowedEmails) : null,
      Date.now(),
      service.id,
    );
  // Turning it off ends every session: a door removed is not a door left open.
  if (!body.enabled) {
    db().query('DELETE FROM app_sessions WHERE service_id = ?').run(service.id);
  }
  emitService(service.id);
  const { syncRoutes } = await import('../../proxy/sync.ts');
  await syncRoutes();
  const fresh = findService(service.id)!;
  return c.json({
    loginRequired: !!fresh.loginRequired,
    allowedEmails: fresh.allowedEmails ?? [],
  });
});

/** Ends one session: that browser is signed out the moment it next asks. */
appLoginRoutes.delete('/:id/login/sessions/:sessionId', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  if (!deleteAppSession(service.id, c.req.param('sessionId'))) throw notFound('That session');
  return c.json({ ok: true });
});
