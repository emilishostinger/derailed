import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import {
  createSession,
  deleteSession,
  deleteSessionsForUser,
  findSession,
  listSessionsForUser,
} from '../../db/repo/sessions.ts';
import {
  claimSetup,
  getBoolSetting,
  releaseSetup,
  SETTINGS,
  setBoolSetting,
} from '../../db/repo/settings.ts';
import {
  confirmTotp,
  countRecoveryCodes,
  countUsers,
  createUser,
  findUserByEmail,
  setTotpLastStep,
  setTotpSecret,
  storeRecoveryCodes,
  totpEnabled,
  totpLastStep,
  totpSecret,
  updateEmail,
  updatePassword,
  useRecoveryCode,
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
import {
  badRequest,
  conflict,
  notFound,
  parseBody,
  parseValue,
  readBody,
  tooManyRequests,
  unauthorized,
} from '../errors.ts';
import {
  generateRecoveryCodes,
  generateSecret,
  otpauthUrl,
  verifyCode,
  verifyCodeStep,
} from '../totp.ts';

export const loginLimiter = new RateLimiter(5, 60_000);
// Exported for the same reason `loginLimiter` is: a test that exercises the sign-up
// surface trips this module-level counter, and the next test file to call setup would
// meet a 429 that has nothing to do with what it is checking. A test resets it.
export const setupLimiter = new RateLimiter(10, 60_000);

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
export const peerLimiter = new RateLimiter(30, 60_000);

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
  const taken = conflict(
    'This server is already set up.',
    'Sign in instead. Locked out? Run `derailed reset-password` on the server.',
  );
  if (getBoolSetting(SETTINGS.setupComplete) || countUsers() > 0) throw taken;

  // Claimed before the first `await`, so two people racing to claim an unconfigured
  // server end with one account rather than two.
  if (!claimSetup()) throw taken;

  try {
    const { email, password } = await parseBody(c, schemas.setupRequest);
    if (countUsers() > 0) throw taken;
    const user = createUser(email, await Bun.password.hash(password));
    setBoolSetting(SETTINGS.setupComplete, true);
    const session = createSession(user.id);
    setSessionCookie(c, session.id);
    return c.json({ user });
  } finally {
    // Always: a rejected password must not leave a server nobody can set up, and
    // once an account exists the guards above turn everyone else away anyway.
    releaseSetup();
  }
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
  // Read once: the schema validates the two required fields, and the code is an
  // optional extra the schema deliberately does not know about.
  const raw = (await readBody(c)) as { code?: string };
  // `parseValue` rather than the schema's own `parse`: that one throws a `ZodError`,
  // which nothing upstream recognises, so it came out as a 500. On the sign-in route.
  const { email, password } = parseValue(schemas.loginRequest, raw);
  const body = raw;
  const record = findUserByEmail(email);
  // Verify against a decoy hash when the email is unknown, so response timing
  // doesn't reveal which emails exist.
  const ok = await Bun.password.verify(password, record?.passwordHash ?? (await decoyHash()));
  if (!record || !ok) {
    throw unauthorized('That email and password do not match.');
  }
  // The password was right. If a second factor is set up, that is not yet enough,
  // and the rate limiter is deliberately not reset until both have passed: otherwise
  // a correct password would buy unlimited attempts at the code.
  if (totpEnabled(record.id)) {
    const secret = totpSecret(record.id);
    const supplied = (body.code ?? '').trim();

    if (!supplied) {
      // Deliberately not an error: the browser needs to know to ask, and "wrong
      // password" would be a lie.
      return c.json({ needsCode: true }, 200);
    }

    let authed = false;
    if (secret) {
      const step = verifyCodeStep(secret, supplied);
      if (step !== null) {
        // A code is good for its whole 30-second step and one either side, which is a
        // window wide enough to replay. Once a step has let someone in, nothing at or
        // before it may again, so a code seen over a shoulder is spent the moment it is
        // used rather than a minute and a half later.
        const last = totpLastStep(record.id);
        if (last !== null && step <= last) {
          throw unauthorized('That code has already been used. Wait for the next one.');
        }
        setTotpLastStep(record.id, step);
        authed = true;
      }
    }
    if (!authed && useRecoveryCode(record.id, supplied)) authed = true;
    if (!authed) throw unauthorized('That code is not right.');
  }

  loginLimiter.reset(ip);
  if (peer) peerLimiter.reset(peer);
  const session = createSession(record.id, c.req.header('user-agent') ?? null, ip);
  setSessionCookie(c, session.id);
  return c.json({ user: { id: record.id, email: record.email, createdAt: record.createdAt } });
});

/**
 * Setting up the second factor.
 *
 * The secret is stored the moment this is called but two-factor is not *on* until a
 * code from it has been proved. Without that step, scanning a QR code and closing the
 * tab would lock somebody out of their own server.
 */
authRoutes.post('/totp/start', requireAuth, (c) => {
  const user = c.get('user');
  const secret = generateSecret();
  setTotpSecret(user.id, secret);
  return c.json({ secret, url: otpauthUrl(secret, user.email) });
});

authRoutes.post('/totp/confirm', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await readBody(c)) as { code?: string };
  const secret = totpSecret(user.id);

  if (!secret) throw badRequest('Start setting it up first.');
  if (!verifyCode(secret, body.code ?? '')) {
    throw badRequest(
      'That code is not right.',
      'Check the clock on your phone if it keeps happening: these codes are based on the time.',
    );
  }

  confirmTotp(user.id);
  // Shown once, here, and never again. Without them this is a way to lock yourself
  // out of your own server for good.
  const codes = generateRecoveryCodes();
  storeRecoveryCodes(user.id, codes);
  return c.json({ enabled: true, recoveryCodes: codes });
});

authRoutes.delete('/totp', requireAuth, async (c) => {
  const user = c.get('user');
  const body = (await readBody(c)) as { password?: string };
  const record = findUserByEmail(user.email);

  // The password again, because turning off a second factor with a stolen session is
  // exactly what a second factor is for.
  if (!record || !(await Bun.password.verify(body.password ?? '', record.passwordHash))) {
    throw unauthorized('That password is not right.');
  }
  setTotpSecret(user.id, null);
  return c.json({ enabled: false });
});

authRoutes.get('/sessions', requireAuth, (c) => {
  const current = c.get('sessionId');
  return c.json({
    sessions: listSessionsForUser(c.get('user').id).map((session) => ({
      ...session,
      current: session.id === current,
    })),
  });
});

authRoutes.delete('/sessions/:id', requireAuth, (c) => {
  const id = c.req.param('id');
  const session = findSession(id);
  // Only your own, whatever id was asked for.
  if (!session || session.userId !== c.get('user').id) throw notFound('That session');
  deleteSession(id);
  return c.json({ ok: true });
});

authRoutes.post('/logout', requireAuth, (c) => {
  deleteSession(c.get('sessionId'));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => {
  const user = currentUser(c);
  if (!user) throw unauthorized();
  return c.json({
    user,
    totpEnabled: totpEnabled(user.id),
    recoveryCodesLeft: countRecoveryCodes(user.id),
  });
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

  const body = (await readBody(c)) as { email?: string; password?: string };
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

  const body = (await readBody(c)) as {
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
