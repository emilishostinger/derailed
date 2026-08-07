import { schemas, topics } from '@derailed/shared';
import { Hono } from 'hono';
import { listProjectEnv, replaceProjectEnv } from '../../db/repo/env.ts';
import {
  createProject,
  findProject,
  renameProject,
  setProjectLimits,
  softDeleteProject,
} from '../../db/repo/projects.ts';
import { listServices } from '../../db/repo/services.ts';
import { destroyContainer, listContainers } from '../../docker/containers.ts';
import { LABELS, labelFilter } from '../../docker/labels.ts';
import { publish } from '../../events/bus.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { emitProject, presentProject, presentProjects } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, parseBody } from '../errors.ts';

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

/**
 * Variables shared by everything in a project.
 *
 * The value an app sees is its own if it has one and this otherwise, so a shared
 * variable is a default rather than a decree. That direction matters: an app that
 * needs a different value sets it and wins, without anybody having to take it off
 * the project first.
 */
projectRoutes.get('/:id/env', (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  return c.json({ vars: listProjectEnv(project.id) });
});

projectRoutes.put('/:id/env', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const body = (await c.req.json().catch(() => ({}))) as {
    vars?: { key?: unknown; value?: unknown }[];
  };
  const vars: { key: string; value: string }[] = [];
  const seen = new Set<string>();

  for (const entry of body.vars ?? []) {
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw badRequest(
        `"${key}" is not a name an environment variable can have.`,
        'Letters, digits and underscores, not starting with a digit.',
      );
    }
    if (seen.has(key)) {
      throw badRequest(`${key} is listed twice. Each variable can only appear once.`);
    }
    seen.add(key);
    vars.push({ key, value: typeof entry.value === 'string' ? entry.value : '' });
  }

  replaceProjectEnv(project.id, vars);
  // Every app in the project is now running with a stale set, so the screens that
  // say "redeploy for this to take effect" have to be looking at fresh services.
  emitProject(project.id);
  return c.json({ vars: listProjectEnv(project.id), redeployNeeded: true });
});

/**
 * A ceiling for everything in this project.
 *
 * Applied per container rather than shared out between them. A quota divided among
 * apps changes every time one is added, and the thing it is meant to stop is one
 * runaway process: capping each container caps the damage, and keeps the number on
 * this screen meaning the same thing next month.
 */
projectRoutes.put('/:id/limits', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const body = (await c.req.json().catch(() => ({}))) as {
    memoryLimitMb?: number | null;
    cpuLimitMillis?: number | null;
  };

  if (body.memoryLimitMb !== undefined && body.memoryLimitMb !== null) {
    // Docker refuses anything under 6 MB, and an app given 6 MB is an app that is
    // killed before it prints anything. Below 64 the limit is the bug.
    if (!Number.isInteger(body.memoryLimitMb) || body.memoryLimitMb < 64) {
      throw badRequest(
        'A memory ceiling has to be at least 64 MB.',
        'Below that an app is killed before it finishes starting, which looks like a crash rather than a limit.',
      );
    }
  }
  if (body.cpuLimitMillis !== undefined && body.cpuLimitMillis !== null) {
    if (!Number.isInteger(body.cpuLimitMillis) || body.cpuLimitMillis < 100) {
      throw badRequest(
        'A processor ceiling has to be at least a tenth of a core.',
        'Written in thousandths: 500 is half a core, 2000 is two.',
      );
    }
  }

  const updated = setProjectLimits(project.id, {
    memoryLimitMb: body.memoryLimitMb,
    cpuLimitMillis: body.cpuLimitMillis,
  });
  emitProject(project.id);
  // Containers are given their limits when they start, so nothing changes until each
  // app is deployed again. Said rather than implied, like every other variable.
  return c.json({ project: updated && presentProject(updated), redeployNeeded: true });
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
