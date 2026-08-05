import { Hono } from 'hono';
import { readDeploymentLog } from '../../build/deploylog.ts';
import { cancelDeployment, queueDeployment, queueRollback } from '../../build/pipeline.ts';
import { hasUpload } from '../../build/upload.ts';
import { findDeployment, listDeployments } from '../../db/repo/deployments.ts';
import { findService } from '../../db/repo/services.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const serviceDeploymentRoutes = new Hono<AppEnv>();
export const deploymentRoutes = new Hono<AppEnv>();

/** GET/POST /services/:id/deployments */
serviceDeploymentRoutes.get('/:id/deployments', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ deployments: listDeployments(service.id) });
});

serviceDeploymentRoutes.post('/:id/deployments', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'app') {
    throw badRequest(
      "Databases don't get deployed. They're either running or stopped.",
      'Use Start or Stop instead.',
    );
  }
  // Only a repository app needs a link. An uploaded one has its files on disk and an
  // image one has its image, and both were told to add a repository they do not have.
  if (service.source === 'repo' && !service.repoUrl) {
    throw badRequest(
      "This app doesn't have a repository link yet.",
      'Add one in Settings, then deploy.',
    );
  }
  if (service.source === 'upload' && !(await hasUpload(service.id))) {
    throw badRequest(
      "This app's files are no longer on the server.",
      "Drag the zip in again from the app's page.",
    );
  }
  if (service.source === 'image' && !service.image) {
    throw badRequest("This app doesn't have an image to run.", 'Set one in Settings.');
  }

  const deployment = queueDeployment(service.id, 'redeploy');
  return c.json({ deployment }, 202);
});

deploymentRoutes.get('/:id', (c) => {
  const deployment = findDeployment(c.req.param('id'));
  if (!deployment) throw notFound('That deploy');
  return c.json({ deployment });
});

deploymentRoutes.get('/:id/logs', async (c) => {
  const deployment = findDeployment(c.req.param('id'));
  if (!deployment) throw notFound('That deploy');
  const tail = Number(c.req.query('tail') ?? 500);
  const lines = await readDeploymentLog(deployment.id, Number.isFinite(tail) ? tail : 500);
  return c.json({ lines });
});

deploymentRoutes.post('/:id/rollback', (c) => {
  const deployment = findDeployment(c.req.param('id'));
  if (!deployment) throw notFound('That deploy');
  return c.json({ deployment: queueRollback(deployment.id) }, 202);
});

deploymentRoutes.post('/:id/cancel', (c) => {
  const deployment = findDeployment(c.req.param('id'));
  if (!deployment) throw notFound('That deploy');
  const cancelled = cancelDeployment(deployment.id);
  if (!cancelled) {
    throw badRequest('That deploy already finished, so there is nothing to cancel.');
  }
  return c.json({ ok: true });
});
