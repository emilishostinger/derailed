import { Hono } from 'hono';
import { applyUpdate, checkUpdates, rebootReason } from '../../system/updates.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest } from '../errors.ts';

export const updateRoutes = new Hono<AppEnv>();

/**
 * Checking talks to apt, the registry and GitHub, so it takes a few seconds. Cached
 * briefly, because the page polls and nothing here changes minute to minute.
 */
let cached: { at: number; report: Awaited<ReturnType<typeof checkUpdates>> } | null = null;
const CACHE_MS = 5 * 60 * 1000;

updateRoutes.get('/', async (c) => {
  const force = c.req.query('refresh') === 'true';
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return c.json({ ...cached.report, cached: true, rebootReason: await rebootReason() });
  }
  const report = await checkUpdates();
  cached = { at: Date.now(), report };
  return c.json({ ...report, cached: false, rebootReason: await rebootReason() });
});

updateRoutes.post('/:id/apply', async (c) => {
  const result = await applyUpdate(c.req.param('id'));
  // Whatever happened, the cached view is now wrong.
  cached = null;
  if (!result.ok) throw badRequest(result.message, result.output?.slice(-3).join(' '));
  return c.json(result);
});
