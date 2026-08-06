import { schemas, topics } from '@derailed/shared';
import { Hono } from 'hono';
import {
  createProject,
  findProject,
  renameProject,
  softDeleteProject,
} from '../../db/repo/projects.ts';
import { listServices } from '../../db/repo/services.ts';
import { destroyContainer, listContainers } from '../../docker/containers.ts';
import { LABELS, labelFilter } from '../../docker/labels.ts';
import { publish } from '../../events/bus.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { emitProject, presentProject, presentProjects } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { notFound, parseBody } from '../errors.ts';

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get('/', (c) => c.json({ projects: presentProjects() }));

projectRoutes.post('/', async (c) => {
  const { name } = await parseBody(c, schemas.createProjectRequest);
  const project = createProject(name);
  emitProject(project.id);
  return c.json({ project: presentProject(project) }, 201);
});

projectRoutes.get('/:id', (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  return c.json({ project: presentProject(project) });
});

projectRoutes.patch('/:id', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  const { name } = await parseBody(c, schemas.patchProjectRequest);
  const updated = renameProject(project.id, name)!;
  emitProject(updated.id);
  return c.json({ project: presentProject(updated) });
});

/**
 * Deleting a project stops everything in it and frees its addresses, but destroys
 * nothing that holds data for a week. See `runtime/trash.ts`.
 *
 * The network is left in place too: rebuilding it on restore would be easy enough,
 * but a project put back should find its apps able to talk to their databases again
 * without a redeploy of each.
 */
projectRoutes.delete('/:id', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  for (const service of listServices(project.id)) {
    const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 5).catch(() => undefined);
  }
  softDeleteProject(project.id);
  await syncRoutes();

  publish(topics.system, { type: 'project.deleted', projectId: project.id });
  return c.json({ ok: true, undoable: true, kind: 'project', id: project.id });
});
