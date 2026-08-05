import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { connectionUrl, credentialsFor, startDatabaseContainer } from '../../catalog/create.ts';
import { DATABASE_ENGINES, findEngine } from '../../catalog/databases.ts';
import { connectServices, disconnectServices, refreshLinksTo } from '../../catalog/links.ts';
import { listLinks } from '../../db/repo/links.ts';
import { findProject } from '../../db/repo/projects.ts';
import { findService, updateService } from '../../db/repo/services.ts';
import { getSetting, SETTINGS } from '../../db/repo/settings.ts';
import { destroyContainer, listContainers } from '../../docker/containers.ts';
import { LABELS, labelFilter } from '../../docker/labels.ts';
import { emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, parseBody } from '../errors.ts';

export const catalogRoutes = new Hono<AppEnv>();
export const connectionRoutes = new Hono<AppEnv>();
export const linkRoutes = new Hono<AppEnv>();

catalogRoutes.get('/databases', (c) =>
  c.json({
    engines: DATABASE_ENGINES.map((engine) => ({
      engine: engine.engine,
      label: engine.label,
      versions: engine.versions,
      blurb: engine.blurb,
      defaultInjectKey: engine.defaultInjectKey,
    })),
  }),
);

/** GET /services/:id/connection */
connectionRoutes.get('/:id/connection', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'database') throw badRequest('That service is not a database.');

  const engine = findEngine(service.dbEngine ?? '');
  const credentials = credentialsFor(service);
  if (!engine || !credentials) throw badRequest('That database is missing its settings.');

  const serverIp = getSetting(SETTINGS.serverIp);
  return c.json({
    connection: {
      host: credentials.host,
      port: engine.port,
      user: credentials.user,
      password: credentials.password,
      dbName: credentials.dbName,
      url: connectionUrl(service),
      exposedPort: service.exposedPort,
      publicUrl:
        service.exposedPort && serverIp
          ? engine
              .urlTemplate({ ...credentials, host: serverIp })
              .replace(`:${engine.port}`, `:${service.exposedPort}`)
          : null,
    },
  });
});

/**
 * Publishing a database port puts it on the public internet. It is off by default and
 * the UI states the consequence before this is ever called.
 */
connectionRoutes.post('/:id/expose', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'database') throw badRequest('That service is not a database.');

  const body = (await c.req.json().catch(() => ({}))) as { exposed?: boolean };
  const exposed = body.exposed === true;

  // A high random port is a small speed bump against drive-by scanners.
  const port = exposed ? 20000 + Math.floor(Math.random() * 20000) : null;
  updateService(service.id, { exposedPort: port });

  // The container has to be recreated for a port mapping to change.
  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  for (const container of containers)
    await destroyContainer(container.Id, 10).catch(() => undefined);
  await startDatabaseContainer(service.id);

  return c.json({ service: emitService(service.id) });
});

/** POST /services/:id/links */
linkRoutes.post('/:id/links', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const body = await parseBody(c, schemas.createLinkRequest);

  const extra = (await c.req.json().catch(() => ({}))) as { discrete?: boolean };
  const { key } = connectServices(service.id, body.toServiceId, body.injectAs, extra.discrete);
  return c.json({ ok: true, key }, 201);
});

linkRoutes.get('/:id/links', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const project = findProject(service.projectId);
  return c.json({ links: project ? listLinks(project.id) : [] });
});

export const singleLinkRoutes = new Hono<AppEnv>();

singleLinkRoutes.delete('/:id', (c) => {
  disconnectServices(c.req.param('id'));
  return c.json({ ok: true });
});

export { refreshLinksTo };
