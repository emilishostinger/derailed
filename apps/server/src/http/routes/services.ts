import { schemas, topics } from '@derailed/shared';
import { Hono } from 'hono';
import { trafficFor } from '../../analytics/store.ts';
import { normalizeRepoUrl, resolveDefaultBranch } from '../../build/git.ts';
import { queueDeployment } from '../../build/pipeline.ts';
import { adoptCurrentCommit } from '../../build/pushes.ts';
import { adoptCurrentRelease } from '../../build/releases.ts';
import { MAX_UPLOAD_BYTES, storeUpload } from '../../build/upload.ts';
import { createDatabaseFromCatalog } from '../../catalog/create.ts';
import { listDomains } from '../../db/repo/domains.ts';
import { listEnv, replaceUserEnv } from '../../db/repo/env.ts';
import { findProject } from '../../db/repo/projects.ts';
import {
  createAppService,
  findService,
  setAccess,
  setRepoToken,
  softDeleteService,
  updateService,
} from '../../db/repo/services.ts';
import { createVolume } from '../../db/repo/volumes.ts';
import {
  destroyContainer,
  listContainers,
  restartContainer,
  startContainer,
  stopContainer,
} from '../../docker/containers.ts';
import { LABELS, labelFilter } from '../../docker/labels.ts';
import { publish } from '../../events/bus.ts';
import { AppMailError, appCanSendMail, mailCredentials, setAppMail } from '../../mail/appmail.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { listFiles, readFile, storageRoots, writeFile } from '../../runtime/files.ts';
import { historyFor } from '../../runtime/metrics.ts';
import { emitProject, emitService, presentService } from '../../runtime/present.ts';
import { previewFile, refreshPreview } from '../../runtime/preview.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, parseBody } from '../errors.ts';

/**
 * A single address or a CIDR range, v4 or v6.
 *
 * Checked here rather than left to Caddy: a typo in this list is a config the proxy
 * rejects wholesale, which would take every site on the machine down over one bad
 * entry in one app's settings.
 */
function isAddressOrRange(value: string): boolean {
  const [address, bits] = value.trim().split('/');
  if (!address) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    if (v4.slice(1).some((part) => Number(part) > 255)) return false;
    return bits === undefined || (Number(bits) >= 0 && Number(bits) <= 32);
  }

  // Deliberately loose on v6: the shapes are many and Caddy is the real judge. This
  // only has to reject things that are obviously not addresses at all.
  if (/^[0-9a-f:]+$/i.test(address) && address.includes(':')) {
    return bits === undefined || (Number(bits) >= 0 && Number(bits) <= 128);
  }
  return false;
}

export const projectServiceRoutes = new Hono<AppEnv>();
export const serviceRoutes = new Hono<AppEnv>();

/** POST /projects/:id/services */
projectServiceRoutes.post('/:id/services', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const body = await parseBody(c, schemas.createServiceRequest);
  if (body.kind === 'database') {
    const service = await createDatabaseFromCatalog(
      project.id,
      body.name,
      body.engine,
      body.version,
    );
    emitProject(project.id);
    return c.json({ service: presentService(service) }, 201);
  }

  // An image is run as-is: nothing to clone, nothing to build.
  const fromImage = body.source === 'image';
  const fromUpload = body.source === 'upload';
  const repo = fromImage || fromUpload ? null : normalizeRepoUrl(body.repoUrl!);
  const branch = repo
    ? body.branch?.trim() || (await resolveDefaultBranch(repo.url)) || 'main'
    : null;

  const service = createAppService({
    projectId: project.id,
    name: body.name,
    source: fromImage ? 'image' : fromUpload ? 'upload' : 'repo',
    image: fromImage ? body.image!.trim() : null,
    repoUrl: repo?.url ?? null,
    branch,
    rootDir: body.rootDir?.trim() || null,
    buildStrategy: body.buildStrategy ?? 'auto',
    dockerfilePath: body.dockerfilePath?.trim() || null,
    port: body.port ?? null,
    healthPath: body.healthPath?.trim() || '/',
  });

  // Templates hand us the variables and storage the app needs up front, so it can
  // come up correctly on its very first deploy rather than failing and being fixed.
  if (body.env && Object.keys(body.env).length > 0) {
    replaceUserEnv(
      service.id,
      Object.entries(body.env).map(([key, value]) => ({ key, value })),
    );
  }
  for (const path of body.volumes ?? []) {
    if (path.trim().startsWith('/')) createVolume(service.id, path.trim());
  }

  if (body.deployNow !== false) queueDeployment(service.id, 'manual');
  emitProject(project.id);
  return c.json({ service: presentService(service) }, 201);
});

/**
 * The title, icon or screenshot of a running site.
 *
 * Served from here rather than as a static file so it is behind the same session
 * check as everything else: what your apps look like is nobody else's business.
 */
serviceRoutes.get('/previews/:name', async (c) => {
  const file = await previewFile(c.req.param('name'));
  if (!file) throw notFound('That preview');
  return new Response(file.bytes, {
    headers: {
      'content-type': file.type,
      // Short, because the point is that it changes. Long enough that a dashboard
      // with a dozen tiles is not a dozen requests every time it is opened.
      'cache-control': 'private, max-age=300',
    },
  });
});

serviceRoutes.post('/:id/preview', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ preview: await refreshPreview(service.id) });
});

serviceRoutes.get('/:id', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ service: presentService(service) });
});

serviceRoutes.patch('/:id', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const patch = await parseBody(c, schemas.patchServiceRequest);
  const updated = updateService(
    service.id,
    patch as Record<string, string | number | boolean | null>,
  );
  if (!updated) throw notFound('That service');

  // Turning either of these on notes where things stand today, so switching it on
  // does not immediately rebuild an app that is already running that very commit or
  // release.
  if (patch.deployOnRelease === true && !updated.lastReleaseTag) {
    await adoptCurrentRelease(updated.id).catch(() => null);
  }
  if (patch.deployOnPush === true && !updated.lastPushedSha) {
    await adoptCurrentCommit(updated.id).catch(() => null);
  }

  const after = findService(updated.id) ?? updated;
  emitService(after.id);
  await syncRoutes();
  return c.json({ service: presentService(after) });
});

/**
 * Deleting stops the app and frees its addresses. It does not destroy anything that
 * holds data: the stored folders, the database contents and the settings stay put for
 * a week, so this is undoable. See `runtime/trash.ts`.
 */
serviceRoutes.delete('/:id', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  // Removed rather than stopped: a stopped container still holds its name, its ports
  // and its place on the network, and restoring redeploys from the image anyway.
  for (const container of containers) {
    await destroyContainer(container.Id, 5).catch(() => undefined);
  }

  const projectId = service.projectId;
  softDeleteService(service.id);
  await syncRoutes();
  publish(topics.project(projectId), {
    type: 'service.deleted',
    serviceId: service.id,
    projectId,
  });
  emitProject(projectId);
  return c.json({ ok: true, undoable: true, kind: 'service', id: service.id });
});

/**
 * Who is allowed to see this app.
 *
 * The password is hashed on the way in and never readable afterwards: the proxy
 * checks it against the hash and Derailed has no reason to be able to read it back.
 */
serviceRoutes.put('/:id/access', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'app') throw badRequest('Only apps are served to visitors.');

  const body = (await c.req.json().catch(() => ({}))) as {
    username?: string | null;
    password?: string | null;
    allowFrom?: string[] | null;
    maintenance?: boolean;
  };

  if (typeof body.password === 'string' && body.password.length > 0 && body.password.length < 6) {
    throw badRequest('Use at least six characters.');
  }

  if (body.allowFrom) {
    for (const entry of body.allowFrom) {
      if (!isAddressOrRange(entry)) {
        throw badRequest(
          `"${entry}" is not an address or a range.`,
          'Use something like 203.0.113.7, or 203.0.113.0/24 for a whole range.',
        );
      }
    }
  }

  const updated = await setAccess(service.id, body);
  await syncRoutes();
  emitService(service.id);
  return c.json({ service: presentService(updated ?? service) });
});

serviceRoutes.post('/:id/start', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  updateService(service.id, { instancesDesired: 1 });
  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  const stopped = containers.filter((container) => container.State !== 'running');

  if (!containers.length) {
    // Nothing has ever been built for this service, deploy instead.
    if (service.kind === 'app') queueDeployment(service.id, 'redeploy');
  } else {
    for (const container of stopped) await startContainer(container.Id).catch(() => undefined);
  }

  await syncRoutes();
  return c.json({ service: emitService(service.id) });
});

serviceRoutes.post('/:id/stop', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  updateService(service.id, { instancesDesired: 0 });
  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  for (const container of containers) await stopContainer(container.Id, 10).catch(() => undefined);

  await syncRoutes();
  return c.json({ service: emitService(service.id) });
});

serviceRoutes.post('/:id/restart', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const containers = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
    () => [],
  );
  const running = containers.filter((container) => container.State === 'running');
  if (!running.length) {
    throw badRequest(
      `${service.name} isn't running, so there's nothing to restart.`,
      'Use Deploy to build and start it.',
    );
  }
  updateService(service.id, { instancesDesired: 1 });
  for (const container of running) await restartContainer(container.Id, 10).catch(() => undefined);
  return c.json({ service: emitService(service.id) });
});

/**
 * A deploy token for a private repository. Write-only by design: it can be replaced
 * or removed, never read back, so a compromised session can't harvest it.
 */
serviceRoutes.put('/:id/repo-token', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'app' || service.source !== 'repo') {
    throw badRequest('Only apps deployed from a repository need a token.');
  }

  const body = (await c.req.json().catch(() => ({}))) as { token?: string | null };
  const token = body.token?.trim() || null;
  if (token && token.length < 20) {
    throw badRequest(
      "That doesn't look like a GitHub token.",
      'Create a fine-grained personal access token with read access to the repository.',
    );
  }

  setRepoToken(service.id, token);
  return c.json({ service: emitService(service.id) });
});

/** Upload (or replace) the files an app is built from. */
serviceRoutes.post('/:id/upload', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  // Checked before the body is read, not after. `formData()` buffers the whole upload
  // first, so a limit applied to the parsed file has already let the thing it was
  // meant to stop through the door.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw badRequest(
      `That file is ${Math.round(declared / 1024 / 1024)} MB, which is bigger than Derailed accepts.`,
      'Remove node_modules and any build output, then zip it again.',
    );
  }

  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    throw badRequest('No file arrived.', 'Drag a .zip of your project onto the app.');
  }

  const { files } = await storeUpload(service.id, file);
  // A repository app that gets files dropped on it becomes an upload app.
  if (service.source !== 'upload') updateService(service.id, { source: 'upload' });

  const deployment = queueDeployment(service.id, 'manual');
  return c.json({ files, deployment, service: emitService(service.id) }, 201);
});

/**
 * What the proxy saw, added up.
 *
 * Nothing here came from a script in anyone's page: Caddy is already in the path of
 * every request, so the figures are a by-product of serving the site rather than
 * something extra done to the people reading it.
 */
/**
 * Whether this app may send email, using whatever Derailed sends its own with.
 *
 * Written as ordinary variables so they are visible on the Variables tab and behave
 * like everything else. Nothing magic, nothing hidden.
 */
serviceRoutes.put('/:id/mail', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  try {
    setAppMail(service.id, body.enabled === true);
  } catch (err) {
    if (err instanceof AppMailError) throw badRequest(err.message, err.hint);
    throw err;
  }
  return c.json({ enabled: appCanSendMail(service.id), redeployNeeded: true });
});

serviceRoutes.get('/:id/mail', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ enabled: appCanSendMail(service.id), available: mailCredentials() !== null });
});

/**
 * An app's own storage, browsable.
 *
 * Confined to the folders explicitly attached as storage, not the whole container.
 * A browser rooted at `/` would be a way to read every process's environment, and
 * there is already a Terminal tab for anybody who means to do that.
 */
serviceRoutes.get('/:id/files', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const roots = storageRoots(service.id);
  const path = c.req.query('path') ?? roots[0];
  if (!path) return c.json({ roots, path: null, entries: [] });

  try {
    return c.json({ roots, path, entries: await listFiles(service.id, path) });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'That folder could not be read.');
  }
});

serviceRoutes.get('/:id/files/read', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const path = c.req.query('path');
  if (!path) throw badRequest('Which file?');

  try {
    return c.json({ path, contents: await readFile(service.id, path) });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'That file could not be read.');
  }
});

serviceRoutes.put('/:id/files', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const body = (await c.req.json().catch(() => ({}))) as { path?: string; contents?: string };
  if (!body.path) throw badRequest('Which file?');
  if (typeof body.contents !== 'string') throw badRequest('There is nothing to save.');

  try {
    await writeFile(service.id, body.path, body.contents);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'That file could not be saved.');
  }
  return c.json({ ok: true });
});

serviceRoutes.get('/:id/metrics', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const range = c.req.query('range');
  return c.json({
    metrics: historyFor(service.id, range === '7d' || range === '30d' ? range : '24h'),
  });
});

serviceRoutes.get('/:id/traffic', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');

  const asked = c.req.query('range');
  const range = asked === '7d' || asked === '30d' ? asked : '24h';
  return c.json({ traffic: trafficFor(service.id, range) });
});

serviceRoutes.get('/:id/env', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ vars: listEnv(service.id) });
});

serviceRoutes.put('/:id/env', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  const { vars } = await parseBody(c, schemas.putEnvRequest);

  const seen = new Set<string>();
  for (const entry of vars) {
    if (seen.has(entry.key)) {
      throw badRequest(`${entry.key} is listed twice. Each variable can only appear once.`);
    }
    seen.add(entry.key);
  }

  replaceUserEnv(service.id, vars);
  emitService(service.id);
  return c.json({ vars: listEnv(service.id) });
});

serviceRoutes.get('/:id/domains', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ domains: listDomains(service.id) });
});
