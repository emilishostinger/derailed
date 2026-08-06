import { topics } from '@derailed/shared';
import { Hono } from 'hono';
import { queueDeployment } from '../../build/pipeline.ts';
import { findProjectEvenIfDeleted } from '../../db/repo/projects.ts';
import { findServiceEvenIfDeleted, listServicesEvenIfDeleted } from '../../db/repo/services.ts';
import { publish } from '../../events/bus.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { emitProject } from '../../runtime/present.ts';
import { listTrash, purge, restore } from '../../runtime/trash.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const trashRoutes = new Hono<AppEnv>();

function parseKind(raw: string): 'project' | 'service' {
  if (raw === 'project' || raw === 'service') return raw;
  throw badRequest('That is not something Derailed keeps in the trash.');
}

trashRoutes.get('/', (c) => c.json({ items: listTrash() }));

/**
 * Puts something back.
 *
 * Apps are redeployed rather than merely un-marked: their containers were removed on
 * delete, so without this a restored app would be listed, addressed, and not running,
 * which is the worst of the three states to be in.
 */
trashRoutes.post('/:kind/:id/restore', async (c) => {
  const kind = parseKind(c.req.param('kind'));
  const id = c.req.param('id');

  if (!restore(kind, id)) throw notFound('That deleted item');

  const services =
    kind === 'project'
      ? listServicesEvenIfDeleted(id).filter((service) => !service.deletedAt)
      : [findServiceEvenIfDeleted(id)].filter((service) => service !== null);

  for (const service of services) {
    if (service.kind === 'app' && service.instancesDesired === 1) {
      queueDeployment(service.id, 'redeploy');
    }
  }

  const projectId = kind === 'project' ? id : (services[0]?.projectId ?? null);
  if (projectId) emitProject(projectId);
  publish(topics.system, { type: 'notice', level: 'info', message: 'Put back.' });
  await syncRoutes();

  return c.json({ items: listTrash() });
});

/** Empties one item now, rather than waiting for the week to be up. */
trashRoutes.delete('/:kind/:id', async (c) => {
  const kind = parseKind(c.req.param('kind'));
  const id = c.req.param('id');

  const existing = kind === 'project' ? findProjectEvenIfDeleted(id) : findServiceEvenIfDeleted(id);
  if (!existing?.deletedAt) throw notFound('That deleted item');

  await purge(kind, id);
  await syncRoutes();
  return c.json({ items: listTrash() });
});
