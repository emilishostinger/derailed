import { schemas } from '@derailed/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { findService, updateService } from '../../db/repo/services.ts';
import {
  grantPass,
  issueChallenge,
  POW_PREFIX,
  verifyChallenge,
  wallsFor,
} from '../../proxy/botguard.ts';
import { emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { notFound, parseBody } from '../errors.ts';
import { forwardedClientIp, fromProxy } from '../proxytrust.ts';

/**
 * The bots screen's two halves: the settings a person changes, and the two
 * endpoints a challenged browser talks to while proving it is one.
 */

export const botRoutes = new Hono<AppEnv>();
export const publicChallengeRoutes = new Hono();

/** What is set, and how many addresses are currently against a wall. */
botRoutes.get('/:id/bots', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  const walls = wallsFor(service.id);
  return c.json({
    mode: service.botMode ?? 'off',
    blockAi: !!service.blockAi,
    challenged: walls.challenged.length,
    banned: walls.banned.length,
  });
});

botRoutes.put('/:id/bots', async (c) => {
  const service = findService(c.req.param('id'));
  if (service?.kind !== 'app') throw notFound('That app');
  const body = await parseBody(c, schemas.botSettingsRequest);
  updateService(service.id, {
    ...(body.mode !== undefined ? { botMode: body.mode } : {}),
    ...(body.blockAi !== undefined ? { blockAi: body.blockAi } : {}),
  });
  emitService(service.id);
  const { syncRoutes } = await import('../../proxy/sync.ts');
  await syncRoutes();
  const fresh = findService(service.id)!;
  return c.json({ mode: fresh.botMode ?? 'off', blockAi: !!fresh.blockAi });
});

/**
 * The challenge, issued and checked. Reached only through the proxy, which
 * attaches the service and the visitor's address; the browser's own JS does the
 * work in between.
 */
/** Only a real proxied request, for an app that actually asked for the wall. */
function challengedService(c: Context) {
  if (!fromProxy(c)) return null;
  const service = findService(c.req.header('x-derailed-service') ?? '');
  if (service?.kind !== 'app' || service.botMode === 'off') return null;
  return service;
}

publicChallengeRoutes.get('/challenge', (c) => {
  const service = challengedService(c);
  const ip = forwardedClientIp(c);
  if (!service || ip === 'unknown') return c.text('No challenge to give.', 404);
  return c.json({ token: issueChallenge(service.id, ip), prefix: POW_PREFIX });
});

publicChallengeRoutes.post('/challenge', async (c) => {
  const service = challengedService(c);
  const ip = forwardedClientIp(c);
  if (!service || ip === 'unknown') return c.text('No challenge to give.', 404);

  const body = (await c.req.json().catch(() => ({}))) as { token?: string; nonce?: string };
  if (
    typeof body.token !== 'string' ||
    typeof body.nonce !== 'string' ||
    !verifyChallenge(body.token, body.nonce, service.id, ip)
  ) {
    return c.text('That is not the answer.', 400);
  }

  // Only push new routes when this solve actually took a wall down. Otherwise a
  // flood of solves for un-walled addresses would spin the proxy through a full
  // config rebuild on every request.
  const before = wallsFor(service.id).challenged.includes(ip);
  grantPass(service.id, ip);
  if (before) {
    const { syncRoutes } = await import('../../proxy/sync.ts');
    await syncRoutes();
  }
  return c.body(null, 204);
});
