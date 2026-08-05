import { Hono } from 'hono';
import { queueDeployment } from '../../build/pipeline.ts';
import { connectionUrl, createDatabaseFromCatalog, credentialsFor } from '../../catalog/create.ts';
import { findEngine } from '../../catalog/databases.ts';
import { connectServices } from '../../catalog/links.ts';
import { APP_TEMPLATES, findTemplate } from '../../catalog/templates.ts';
import { replaceUserEnv } from '../../db/repo/env.ts';
import { findProject } from '../../db/repo/projects.ts';
import { createAppService, deleteService, findService } from '../../db/repo/services.ts';
import { createVolume } from '../../db/repo/volumes.ts';
import { emitProject, presentService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const templateRoutes = new Hono<AppEnv>();
export const projectTemplateRoutes = new Hono<AppEnv>();

templateRoutes.get('/', (c) =>
  c.json({
    templates: APP_TEMPLATES.map((template) => ({
      slug: template.slug,
      name: template.name,
      blurb: template.blurb,
      category: template.category,
      needsDatabase: !!template.database,
      afterDeploy: template.afterDeploy,
    })),
  }),
);

/**
 * POST /projects/:id/templates. The one click.
 *
 * Creates the database, waits for its credentials, creates the app with those
 * credentials already filled in, attaches the storage that has to survive a
 * redeploy, links the two so the topology shows it, and starts the deploy.
 */
projectTemplateRoutes.post('/:id/templates', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const body = (await c.req.json().catch(() => ({}))) as { slug?: string; name?: string };
  const template = findTemplate(body.slug ?? '');
  if (!template) throw badRequest("Derailed doesn't have an app by that name.");

  const name = body.name?.trim() || template.slug;
  let databaseId: string | null = null;
  let env: Record<string, string> = { ...(template.env ?? {}) };

  if (template.database) {
    const database = await createDatabaseFromCatalog(
      project.id,
      `${name}-db`,
      template.database.engine,
      template.database.version,
    );
    databaseId = database.id;

    const engine = findEngine(template.database.engine);
    const credentials = credentialsFor(database);
    const url = connectionUrl(database);
    if (!engine || !credentials || !url) {
      // Don't leave a half-built app behind if the database didn't come up.
      deleteService(database.id);
      throw badRequest(`Derailed couldn't set up the database for ${template.name}.`);
    }

    env = {
      ...env,
      ...template.database.env({
        host: credentials.host,
        port: engine.port,
        dbName: credentials.dbName,
        user: credentials.user,
        password: credentials.password,
        url,
      }),
    };
  }

  const app = createAppService({
    projectId: project.id,
    name,
    source: 'image',
    image: template.image,
    framework: template.name,
    repoUrl: null,
    branch: null,
    port: template.port,
  });

  replaceUserEnv(
    app.id,
    Object.entries(env).map(([key, value]) => ({ key, value })),
  );
  for (const path of template.volumes) createVolume(app.id, path);

  if (databaseId) {
    // Best effort: the app already has the credentials it needs in its variables.
    // The link exists so the canvas shows the relationship and unlinking cleans up.
    try {
      connectServices(app.id, databaseId);
    } catch {
      // A template whose variables don't include a DATABASE_URL will clash; harmless.
    }
  }

  queueDeployment(app.id, 'manual');
  emitProject(project.id);

  return c.json(
    {
      service: presentService(findService(app.id)!),
      afterDeploy: template.afterDeploy,
    },
    201,
  );
});
