import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { emitService } from '../../runtime/present.ts';
import {
  appUpdateState,
  beginAppUpdate,
  revertAppUpdate,
  setAutoUpdate,
} from '../../system/appupdate.ts';
import type { AppEnv } from '../auth.ts';
import { parseBody } from '../errors.ts';

/**
 * Backup-first updates for one app.
 *
 * Updating and reverting are a member's business, like deploying: the role table
 * already lets a member deploy whatever they like, so updating the image is nothing
 * they could not do more slowly. Viewers are turned away from the writes by the
 * role table, and the read is safe for anyone who can see the app.
 */
export const appUpdateRoutes = new Hono<AppEnv>();

/** What is running, what is available, and how past updates went. */
appUpdateRoutes.get('/:id/update', async (c) => c.json(await appUpdateState(c.req.param('id'))));

/**
 * Starts a backup-first update and answers straight away. The backup of a real
 * project takes minutes, and a browser held open for minutes is a timeout; the
 * update row streams its progress over the event socket instead.
 */
appUpdateRoutes.post('/:id/update', async (c) => {
  const { update, done } = await beginAppUpdate(c.req.param('id'), 'manual');
  // Not awaited. The row and its events are the answer; errors land on the row.
  void done.catch(() => undefined);
  return c.json({ update }, 202);
});

/** One press puts it back the way it was: the recorded digest, redeployed. */
appUpdateRoutes.post('/:id/update/revert', async (c) => {
  const update = await revertAppUpdate(c.req.param('id'));
  return c.json({ update });
});

/** The only setting updating has: whether it happens without being asked. */
appUpdateRoutes.put('/:id/auto-update', async (c) => {
  const body = await parseBody(c, schemas.autoUpdateRequest);
  const service = setAutoUpdate(c.req.param('id'), body.enabled);
  emitService(service.id);
  return c.json({ autoUpdate: !!service.autoUpdate });
});
