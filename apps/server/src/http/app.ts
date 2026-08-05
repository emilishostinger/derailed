import { Hono } from 'hono';
import { VERSION } from '../config.ts';
import { type AppEnv, requireAuth, requireCsrfHeader } from './auth.ts';
import { errorResponse, notFound } from './errors.ts';
import { authRoutes } from './routes/auth.ts';
import { backupRoutes } from './routes/backups.ts';
import { catalogRoutes, connectionRoutes, linkRoutes, singleLinkRoutes } from './routes/catalog.ts';
import { deploymentRoutes, serviceDeploymentRoutes } from './routes/deployments.ts';
import { detectRoutes } from './routes/detect.ts';
import { domainRoutes, serviceDomainRoutes } from './routes/domains.ts';
import { projectRoutes } from './routes/projects.ts';
import { projectServiceRoutes, serviceRoutes } from './routes/services.ts';
import { systemRoutes } from './routes/system.ts';
import { projectTemplateRoutes, templateRoutes } from './routes/templates.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { updateRoutes } from './routes/updates.ts';
import { serviceVolumeRoutes, volumeRoutes } from './routes/volumes.ts';
import { serveApp } from './static.ts';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => errorResponse(c, err));

  const api = new Hono<AppEnv>();
  api.use('*', requireCsrfHeader);

  api.get('/health', (c) => c.json({ ok: true, version: VERSION }));
  api.route('/auth', authRoutes);

  // Everything below needs a session.
  api.use('*', requireAuth);
  api.route('/system', systemRoutes);
  api.route('/detect', detectRoutes);
  api.route('/projects', projectRoutes);
  api.route('/projects', projectServiceRoutes);
  api.route('/projects', projectTemplateRoutes);
  api.route('/services', serviceRoutes);
  api.route('/services', serviceDeploymentRoutes);
  api.route('/services', serviceDomainRoutes);
  api.route('/services', connectionRoutes);
  api.route('/services', linkRoutes);
  api.route('/services', serviceVolumeRoutes);
  api.route('/deployments', deploymentRoutes);
  api.route('/domains', domainRoutes);
  api.route('/links', singleLinkRoutes);
  api.route('/catalog', catalogRoutes);
  api.route('/templates', templateRoutes);
  api.route('/volumes', volumeRoutes);
  api.route('/tokens', tokenRoutes);
  api.route('/updates', updateRoutes);
  api.route('/backups', backupRoutes);

  api.all('*', () => {
    throw notFound('That endpoint');
  });

  app.route('/api', api);

  // Anything that isn't /api is the dashboard.
  app.all('*', (c) => serveApp(c.req.raw));

  return app;
}

export type App = ReturnType<typeof createApp>;
