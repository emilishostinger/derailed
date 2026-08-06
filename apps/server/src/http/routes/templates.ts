import { Hono } from 'hono';
import { queueDeployment } from '../../build/pipeline.ts';
import { connectionUrl, createDatabaseFromCatalog, credentialsFor } from '../../catalog/create.ts';
import { findEngine } from '../../catalog/databases.ts';
import { connectServices } from '../../catalog/links.ts';
import {
  APP_TEMPLATES,
  CATEGORY_ORDER,
  fetchTemplate,
  findTemplate,
  TemplateError,
} from '../../catalog/templates.ts';
import { replaceUserEnv } from '../../db/repo/env.ts';
import { findProject } from '../../db/repo/projects.ts';
import { createAppService, deleteService, findService } from '../../db/repo/services.ts';
import { createVolume } from '../../db/repo/volumes.ts';
import { emitProject, presentService } from '../../runtime/present.ts';
import { randomSecret } from '../../util/crypto.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const templateRoutes = new Hono<AppEnv>();
export const projectTemplateRoutes = new Hono<AppEnv>();

/**
 * Sorted here rather than in the browser. The client groups by the order it first
 * sees a category, so the order of this list *is* the order of the headings, and
 * which of these people should see first is a decision about the catalogue.
 */
templateRoutes.get('/', (c) =>
  c.json({
    templates: [...APP_TEMPLATES]
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
      .map((template) => ({
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

  // Secrets that have to exist but must differ per server. Generated here rather than
  // written into the catalogue, because a password shipped in the source is not one.
  for (const key of template.generatedEnv ?? []) env[key] = randomSecret(24);

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
    command: template.command ?? null,
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

/**
 * A template from a link.
 *
 * Twenty ready-made apps is a feature; two hundred is a moat, and it is the one part
 * of this anybody else can build. Fetched, validated hard, and shown before anything
 * is created, because the person should see what they are about to run.
 */
templateRoutes.post('/from-url', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  if (!body.url?.trim()) throw badRequest('Paste the address of a template file.');

  try {
    return c.json({ template: await fetchTemplate(body.url.trim()) });
  } catch (err) {
    if (err instanceof TemplateError) throw badRequest(err.message, err.hint);
    throw err;
  }
});
