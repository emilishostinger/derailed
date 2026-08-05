import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { createSession, deleteSession, deleteSessionsForUser } from '../../db/repo/sessions.ts';
import { getBoolSetting, SETTINGS, setBoolSetting } from '../../db/repo/settings.ts';
import {
  countUsers,
  createUser,
  findUserByEmail,
  updateEmail,
  updatePassword,
} from '../../db/repo/users.ts';
import {
  type AppEnv,
  clearSessionCookie,
  clientIp,
  currentUser,
  peerAddress,
  RateLimiter,
  requireAuth,
  setSessionCookie,
} from '../auth.ts';
import { badRequest, conflict, parseBody, tooManyRequests, unauthorized } from '../errors.ts';

const loginLimiter = new RateLimiter(5, 60_000);
const setupLimiter = new RateLimiter(10, 60_000);

/**
 * A second, looser ceiling held against the socket address itself, whatever any
 * forwarded header says.
 *
 * The header can only be believed when the connection came from our own proxy, and
 * once it is believed, whoever is on that connection can write a different value into
 * it on every request and get a fresh allowance each time. From the internet that is
 * nobody. From a compromised app container on the same Docker bridge, it is unlimited
 * guesses at the admin password.
 *
 * So: attempts arriving down one socket are capped too. Generous, because behind Caddy
 * every real visitor shares that one address and a person mistyping their password a
 * few times must not be stopped, but finite, which is the entire point.
 */
const peerLimiter = new RateLimiter(30, 60_000);

let decoy: Promise<string> | null = null;
const decoyHash = () => (decoy ??= Bun.password.hash('derailed-decoy-password'));

export const authRoutes = new Hono<AppEnv>();

/** Unauthenticated: lets the SPA decide between the onboarding and sign-in screens. */
authRoutes.get('/status', (c) =>
  c.json({ setupComplete: getBoolSetting(SETTINGS.setupComplete) || countUsers() > 0 }),
);

authRoutes.post('/setup', async (c) => {
  if (!setupLimiter.check(clientIp(c))) {
    throw tooManyRequests('Too many attempts. Wait a minute and try again.');
  }
  if (getBoolSetting(SETTINGS.setupComplete) || countUsers() > 0) {
    throw conflict(
      'This server is already set up.',
      'Sign in instead. Locked out? Run `derailed reset-password` on the server.',
    );
  }
  const { email, password } = await parseBody(c, schemas.setupRequest);
  const user = createUser(email, await Bun.password.hash(password));
  setBoolSetting(SETTINGS.setupComplete, true);
  const session = createSession(user.id);
  setSessionCookie(c, session.id);
  return c.json({ user });
});

authRoutes.post('/login', async (c) => {
  const ip = clientIp(c);
  const peer = peerAddress(c);
  const tooMany = tooManyRequests(
    'Too many sign-in attempts.',
    'Wait a minute before trying again. Forgot the password? Run `derailed reset-password` on the server.',
  );
  if (!loginLimiter.check(ip)) throw tooMany;
  if (peer && !peerLimiter.check(peer)) throw tooMany;
  const { email, password } = await parseBody(c, schemas.loginRequest);
  const record = findUserByEmail(email);
  // Verify against a decoy hash when the email is unknown, so response timing
  // doesn't reveal which emails exist.
  const ok = await Bun.password.verify(password, record?.passwordHash ?? (await decoyHash()));
  if (!record || !ok) {
    throw unauthorized('That email and password do not match.');
  }
  loginLimiter.reset(ip);
  if (peer) peerLimiter.reset(peer);
  const session = createSession(record.id);
  setSessionCookie(c, session.id);
  return c.json({ user: { id: record.id, email: record.email, createdAt: record.createdAt } });
});

authRoutes.post('/logout', requireAuth, (c) => {
  deleteSession(c.get('sessionId'));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => {
  const user = currentUser(c);
  if (!user) throw unauthorized();
  return c.json({ user });
});

/**
 * Changing the address you sign in with.
 *
 * The current password is required even though the session is already trusted: an
 * unattended browser should not be enough to move the account somewhere else.
 */
authRoutes.patch('/me/email', requireAuth, async (c) => {
  const user = currentUser(c);
  if (!user) throw unauthorized();

  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw badRequest("That doesn't look like an email address.");
  }

  const record = findUserByEmail(user.email);
  const ok = record && (await Bun.password.verify(body.password ?? '', record.passwordHash));
  if (!ok) throw unauthorized('That password is not right.');

  const taken = findUserByEmail(email);
  if (taken && taken.id !== user.id) throw conflict('Someone already signs in with that address.');

  updateEmail(user.id, email);
  return c.json({ user: { ...user, email } });
});

/**
 * Changing the password.
 *
 * Every other session is ended. If the reason for changing it is that someone else
 * knows the old one, leaving their session alive would defeat the whole exercise.
 */
authRoutes.patch('/me/password', requireAuth, async (c) => {
  const user = currentUser(c);
  if (!user) throw unauthorized();

  const body = (await c.req.json().catch(() => ({}))) as {
    current?: string;
    password?: string;
  };
  if ((body.password ?? '').length < schemas.MIN_PASSWORD_LENGTH) {
    throw badRequest(
      `Use at least ${schemas.MIN_PASSWORD_LENGTH} characters.`,
      'A short phrase you can remember is fine.',
    );
  }

  const record = findUserByEmail(user.email);
  const ok = record && (await Bun.password.verify(body.current ?? '', record.passwordHash));
  if (!ok) throw unauthorized('That password is not right.');

  updatePassword(user.id, await Bun.password.hash(body.password!));
  deleteSessionsForUser(user.id);

  // This browser stays signed in: ending the session someone is holding would look
  // like a failure, and they have just proved who they are twice over.
  const session = createSession(user.id);
  setSessionCookie(c, session.id);
  return c.json({ ok: true });
});
