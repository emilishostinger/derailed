import { Hono } from 'hono';
import { emitProject, presentService } from '../../runtime/present.ts';
import {
  adminLoginUrl,
  createStaging,
  listWpUpdates,
  pushStagingLive,
  updateWordPress,
  WordPressError,
  wordPressState,
} from '../../system/wordpress.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, readBody } from '../errors.ts';

/**
 * WordPress superpowers: four buttons on an app that already exists.
 *
 * Everything here answers 400 with WP-CLI's own words when the site refuses,
 * because "wp plugin update failed" with the reason is actionable and a bare 500
 * is a support thread.
 */
export const wordPressRoutes = new Hono<AppEnv>();

const friendly = (err: unknown): never => {
  if (err instanceof WordPressError) throw badRequest(err.message, err.hint);
  throw err;
};

wordPressRoutes.get('/:id/wordpress', async (c) => c.json(await wordPressState(c.req.param('id'))));

wordPressRoutes.post('/:id/wordpress/login', async (c) => {
  const url = await adminLoginUrl(c.req.param('id')).catch(friendly);
  return c.json({ url });
});

wordPressRoutes.get('/:id/wordpress/updates', async (c) => {
  const updates = await listWpUpdates(c.req.param('id')).catch(friendly);
  return c.json({ updates });
});

wordPressRoutes.post('/:id/wordpress/update', async (c) => {
  const body = (await readBody(c)) as { what?: string };
  const what = body.what;
  if (what !== 'plugins' && what !== 'themes' && what !== 'core' && what !== 'all') {
    throw badRequest('Update what?', 'plugins, themes, core, or all.');
  }
  const result = await updateWordPress(c.req.param('id'), what).catch(friendly);
  return c.json(result);
});

wordPressRoutes.post('/:id/wordpress/staging', async (c) => {
  const staging = await createStaging(c.req.param('id')).catch(friendly);
  emitProject(staging.projectId);
  return c.json({ staging: presentService(staging) }, 201);
});

wordPressRoutes.post('/:id/wordpress/staging/push', async (c) => {
  const result = await pushStagingLive(c.req.param('id')).catch(friendly);
  return c.json(result);
});
