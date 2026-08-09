import type { schemas } from '@derailed/shared';
import { Hono } from 'hono';

type PatchServiceRequest = schemas.PatchServiceRequest;

import { listEnv, listProjectEnv, replaceProjectEnv, replaceUserEnv } from '../../db/repo/env.ts';
import {
  countPending,
  discardPending,
  envDiff,
  listPending,
  recordEnvHistory,
} from '../../db/repo/pending.ts';
import { findProject, setReviewChanges } from '../../db/repo/projects.ts';
import { findService } from '../../db/repo/services.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { emitProject, emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, readBody } from '../errors.ts';
import { assertHostnamesUsable, attachHostnames } from './domains.ts';
import { applyServicePatch } from './services.ts';

/**
 * What will change.
 *
 * With a project's review switch on, edits to variables, settings and domains
 * collect instead of applying, and this is the screen between editing and
 * production: the list, the diff, one Apply for all of it, and a discard for the
 * edit that should never have been staged.
 *
 * Applying replays each edit through the same function the live route would have
 * used, oldest first, and re-validates on the way: the world may have moved since
 * the edit was staged, and a change that no longer applies is reported in a
 * sentence rather than half-done.
 */
export const pendingRoutes = new Hono<AppEnv>();

pendingRoutes.get('/:id/pending', (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  return c.json({
    reviewChanges: !!project.reviewChanges,
    changes: listPending(project.id).map(({ payload: _payload, ...change }) => change),
  });
});

pendingRoutes.put('/:id/review', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  const body = (await readBody(c)) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') throw badRequest('On or off?');

  // Turning review off with edits still waiting must not quietly apply them, and
  // must not quietly bin them either. The queue stays; the screen still shows it.
  const updated = setReviewChanges(project.id, body.enabled);
  emitProject(project.id);
  return c.json({
    reviewChanges: !!updated?.reviewChanges,
    pending: countPending(project.id),
  });
});

pendingRoutes.delete('/:id/pending/:changeId', (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  discardPending(project.id, c.req.param('changeId'));
  return c.json({ pending: countPending(project.id) });
});

pendingRoutes.delete('/:id/pending', (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');
  discardPending(project.id);
  return c.json({ pending: 0 });
});

pendingRoutes.post('/:id/pending/apply', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const changes = listPending(project.id);
  const by = c.get('user').email;
  const results: { id: string; summary: string; ok: boolean; note: string | null }[] = [];
  const touchedServices = new Set<string>();
  let envMoved = false;

  for (const change of changes) {
    try {
      switch (change.kind) {
        case 'env': {
          const service = change.serviceId ? findService(change.serviceId) : null;
          if (!service) throw new Error('That app no longer exists.');
          const { vars } = change.payload as { vars: { key: string; value: string }[] };
          const before = listEnv(service.id).filter((entry) => entry.source === 'user');
          replaceUserEnv(service.id, vars);
          recordEnvHistory({ serviceId: service.id }, envDiff(before, vars), by);
          touchedServices.add(service.id);
          envMoved = true;
          break;
        }
        case 'project-env': {
          const { vars } = change.payload as { vars: { key: string; value: string }[] };
          const before = listProjectEnv(project.id);
          replaceProjectEnv(project.id, vars);
          recordEnvHistory({ projectId: project.id }, envDiff(before, vars), by);
          envMoved = true;
          break;
        }
        case 'setting': {
          const service = change.serviceId ? findService(change.serviceId) : null;
          if (!service) throw new Error('That app no longer exists.');
          await applyServicePatch(service.id, change.payload as PatchServiceRequest);
          touchedServices.add(service.id);
          break;
        }
        case 'domain-attach': {
          const service = change.serviceId ? findService(change.serviceId) : null;
          if (!service) throw new Error('That app no longer exists.');
          const { wanted } = change.payload as { wanted: string[] };
          // Re-checked now: the hostname may have been taken since it was staged.
          assertHostnamesUsable(wanted, service.id);
          await attachHostnames(service.id, wanted);
          touchedServices.add(service.id);
          break;
        }
      }
      results.push({ id: change.id, summary: change.summary, ok: true, note: null });
      discardPending(project.id, change.id);
    } catch (err) {
      // The edit stays in the queue with its reason, so nothing is half-lost. The
      // rest still apply: three good changes must not wait on one stale one.
      results.push({
        id: change.id,
        summary: change.summary,
        ok: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await syncRoutes();
  for (const serviceId of touchedServices) emitService(serviceId);
  emitProject(project.id);

  return c.json({
    results,
    pending: countPending(project.id),
    // Variables reach an app on its next deploy; the screen should say so once,
    // here, rather than each editing screen pretending the change is already live.
    redeployNeeded: envMoved,
  });
});
