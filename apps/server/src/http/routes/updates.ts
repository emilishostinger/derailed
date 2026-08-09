import { Hono } from 'hono';
import { SETTINGS, setBoolSetting } from '../../db/repo/settings.ts';
import { autoUpdateState, runSecurityUpdates } from '../../system/autoupdate.ts';
import { applyUpdate, checkUpdates, rebootReason } from '../../system/updates.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, readBody } from '../errors.ts';

export const updateRoutes = new Hono<AppEnv>();

/** Whether the operating system's security updates are applied without being asked. */
updateRoutes.get('/automatic', async (c) => c.json({ automatic: await autoUpdateState() }));

updateRoutes.put('/automatic', async (c) => {
  const body = (await readBody(c)) as { enabled?: boolean };
  const wanted = body.enabled === true;

  if (wanted) {
    const state = await autoUpdateState();
    if (!state.supported) {
      throw badRequest(
        state.manager
          ? `${state.manager} cannot separate security updates from the rest.`
          : 'Derailed does not recognise this machine’s package manager.',
        'Applying everything on a timer is a bigger decision than this switch, so the button on this page stays the way to do it.',
      );
    }
  }

  setBoolSetting(SETTINGS.autoSecurityUpdates, wanted);
  return c.json({ automatic: await autoUpdateState() });
});

/** Runs them now, rather than waiting for the daily check. */
updateRoutes.post('/automatic/run', async (c) =>
  c.json({ result: await runSecurityUpdates(), automatic: await autoUpdateState() }),
);

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
