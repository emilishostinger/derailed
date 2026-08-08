import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { findEngine } from '../../catalog/databases.ts';
import { pitrState, restoreToMoment, setPitr } from '../../catalog/pitr.ts';
import { beginDbUpgrade, dbUpgradeState } from '../../catalog/upgrade.ts';
import { findService } from '../../db/repo/services.ts';
import { publish } from '../../events/bus.ts';
import type { AppEnv } from '../auth.ts';
import { notFound, parseBody } from '../errors.ts';

/**
 * Growing a database up, and winding one back.
 *
 * Both are a member's business for the same reason restoring an hourly copy is:
 * a member already holds the data and the levers next to it. Viewers are turned
 * away from every write by the role table.
 */
export const dbUpgradeRoutes = new Hono<AppEnv>();

/** What this database could move up to, and how past moves went. */
dbUpgradeRoutes.get('/:id/upgrade', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  const engine = findEngine(service.dbEngine ?? '');
  return c.json({
    engine: engine?.label ?? null,
    current: service.dbVersion ?? null,
    ...dbUpgradeState(service.id),
  });
});

/**
 * Starts an upgrade and answers straight away; the row reports over the socket.
 * A dump, a fresh engine and a reload can take minutes on a real database.
 */
dbUpgradeRoutes.post('/:id/upgrade', async (c) => {
  const body = await parseBody(c, schemas.upgradeDatabaseRequest);
  const { upgrade, done } = await beginDbUpgrade(c.req.param('id'), body.version);
  void done.catch(() => undefined);
  return c.json({ upgrade }, 202);
});

/** Whether the point-in-time archive is on, and how far back it reaches. */
dbUpgradeRoutes.get('/:id/pitr', async (c) => c.json(await pitrState(c.req.param('id'))));

dbUpgradeRoutes.put('/:id/pitr', async (c) => {
  const body = await parseBody(c, schemas.pitrToggleRequest);
  return c.json(await setPitr(c.req.param('id'), body.enabled));
});

/**
 * Winds the database back to a moment. Also answered straight away: the replay
 * takes as long as it takes, and the outcome lands as a notice and on the
 * database's screen.
 */
dbUpgradeRoutes.post('/:id/pitr/restore', async (c) => {
  const body = await parseBody(c, schemas.pitrRestoreRequest);
  const serviceId = c.req.param('id');
  const service = findService(serviceId);
  if (!service) throw notFound('That database');

  void restoreToMoment(serviceId, body.at)
    .then(() =>
      publish('system', {
        type: 'notice',
        level: 'info',
        message: `${service.name} is back to how it was at ${new Date(body.at).toLocaleString()}.`,
      }),
    )
    .catch((err) =>
      publish('system', {
        type: 'notice',
        level: 'error',
        message: `Winding ${service.name} back did not complete: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
    );
  return c.json({ started: true }, 202);
});
