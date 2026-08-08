import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import {
  INTERVALS,
  listSnapshots,
  restoreSnapshot,
  snapshotAt,
  takeSnapshot,
} from '../../backup/snapshots.ts';
import { FriendlyError } from '../../build/git.ts';
import {
  browseKeys,
  browseKind,
  canBrowse,
  getDocument,
  getKey,
  listTables,
  putDocument,
  putKey,
  readTable,
  removeDocument,
  removeKey,
  runQuery,
  updateCell,
} from '../../catalog/browse.ts';
import { connectionUrl, credentialsFor, startDatabaseContainer } from '../../catalog/create.ts';
import { DATABASE_ENGINES, findEngine } from '../../catalog/databases.ts';
import { connectServices, disconnectServices, refreshLinksTo } from '../../catalog/links.ts';
import { listLinks } from '../../db/repo/links.ts';
import { findProject } from '../../db/repo/projects.ts';
import {
  deleteSavedQuery,
  findSavedQuery,
  listSavedQueries,
  saveQuery,
} from '../../db/repo/queries.ts';
import { findService, updateService } from '../../db/repo/services.ts';
import { getSetting, SETTINGS } from '../../db/repo/settings.ts';
import { destroyContainer, listContainers } from '../../docker/containers.ts';
import { LABELS, labelFilter } from '../../docker/labels.ts';
import { emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, parseBody } from '../errors.ts';

export const catalogRoutes = new Hono<AppEnv>();
/**
 * Looking inside a database.
 *
 * Runs the engine's own client inside the database's own container, so there is no
 * driver bundled here, no port opened, and nothing new listening anywhere.
 */
export const browseRoutes = new Hono<AppEnv>();

/** The one thing every screen here needs first: a database Derailed can actually read. */
function browsable(id: string) {
  const service = findService(id);
  if (!service) throw notFound('That database');
  if (!canBrowse(service.dbEngine)) {
    throw badRequest(
      `Derailed cannot browse ${service.dbEngine ?? 'this'} yet.`,
      "Its Terminal tab has the engine's own client on it.",
    );
  }
  return service;
}

/** Every route here says what the engine said, rather than a house error over the top. */
async function speaking<T>(work: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : fallback);
  }
}

browseRoutes.get('/:id/tables', async (c) => {
  const service = browsable(c.req.param('id'));
  return c.json({
    kind: browseKind(service.dbEngine),
    tables: await speaking(() => listTables(service.id), 'That database could not be read.'),
  });
});

browseRoutes.get('/:id/tables/:table', async (c) => {
  const service = browsable(c.req.param('id'));
  return c.json({
    result: await speaking(
      () =>
        readTable(
          service.id,
          c.req.param('table'),
          Number(c.req.query('limit') ?? 100) || 100,
          Number(c.req.query('offset') ?? 0) || 0,
        ),
      'That did not work.',
    ),
  });
});

/**
 * Changes one cell.
 *
 * A `null` value is a real null rather than a missing field, which is why the body is
 * checked for the key being present rather than for the value being truthy. Clearing
 * a cell to empty and clearing it to null are different things, and a screen that
 * cannot express both is a screen people stop trusting.
 */
browseRoutes.put('/:id/tables/:table/cell', async (c) => {
  const service = browsable(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as {
    key?: Record<string, string | null>;
    column?: string;
    value?: string | null;
  };
  if (!body.key || typeof body.key !== 'object') throw badRequest('Which row?');
  if (!body.column) throw badRequest('Which column?');
  if (!('value' in body)) throw badRequest('There is nothing to save.');

  await speaking(
    () =>
      updateCell(
        service.id,
        c.req.param('table'),
        body.key ?? {},
        body.column ?? '',
        body.value ?? null,
      ),
    'That change could not be saved.',
  );
  return c.json({ ok: true });
});

browseRoutes.post('/:id/query', async (c) => {
  const service = browsable(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { sql?: string; body?: string };
  // `sql` is what this was called when only three engines could be browsed. Kept so an
  // older client, or a script somebody wrote against it, still works.
  const statement = (body.body ?? body.sql ?? '').trim();
  if (!statement) throw badRequest('There is nothing to run.');

  return c.json({
    result: await speaking(() => runQuery(service.id, statement), 'That did not work.'),
  });
});

/** One document, as the JSON somebody would edit. MongoDB only. */
browseRoutes.get('/:id/collections/:name/:documentId', async (c) => {
  const service = browsable(c.req.param('id'));
  return c.json({
    document: await speaking(
      () => getDocument(service.id, c.req.param('name'), c.req.param('documentId')),
      'That document could not be read.',
    ),
  });
});

browseRoutes.put('/:id/collections/:name/:documentId', async (c) => {
  const service = browsable(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { document?: string };
  if (typeof body.document !== 'string') throw badRequest('There is nothing to save.');

  await speaking(
    () =>
      putDocument(service.id, c.req.param('name'), c.req.param('documentId'), body.document ?? ''),
    'That document could not be saved.',
  );
  return c.json({ ok: true });
});

browseRoutes.delete('/:id/collections/:name/:documentId', async (c) => {
  const service = browsable(c.req.param('id'));
  await speaking(
    () => removeDocument(service.id, c.req.param('name'), c.req.param('documentId')),
    'That document could not be deleted.',
  );
  return c.json({ ok: true });
});

/**
 * Keys, for Redis and Valkey.
 *
 * Paged by cursor rather than by offset, because that is what `SCAN` gives and
 * pretending otherwise would mean `KEYS *`, which blocks the server for as long as it
 * takes to walk every key. A browsing screen should not be able to take a site down.
 */
browseRoutes.get('/:id/keys', async (c) => {
  const service = browsable(c.req.param('id'));
  return c.json({
    page: await speaking(
      () => browseKeys(service.id, c.req.query('pattern') ?? '*', c.req.query('cursor') ?? '0'),
      'Those keys could not be read.',
    ),
  });
});

browseRoutes.get('/:id/keys/value', async (c) => {
  const service = browsable(c.req.param('id'));
  const key = c.req.query('key');
  if (!key) throw badRequest('Which key?');
  return c.json({
    value: await speaking(() => getKey(service.id, key), 'That key could not be read.'),
  });
});

browseRoutes.put('/:id/keys/value', async (c) => {
  const service = browsable(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  if (!body.key) throw badRequest('Which key?');
  if (typeof body.value !== 'string') throw badRequest('There is nothing to save.');

  await speaking(
    () => putKey(service.id, body.key ?? '', body.value ?? ''),
    'That key could not be saved.',
  );
  return c.json({ ok: true });
});

browseRoutes.delete('/:id/keys', async (c) => {
  const service = browsable(c.req.param('id'));
  const key = c.req.query('key');
  if (!key) throw badRequest('Which key?');
  await speaking(() => removeKey(service.id, key), 'That key could not be deleted.');
  return c.json({ ok: true });
});

/** Queries worth keeping, against this database. */
browseRoutes.get('/:id/queries', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  return c.json({ queries: listSavedQueries(service.id) });
});

browseRoutes.post('/:id/queries', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; body?: string };
  const name = body.name?.trim();
  if (!name) throw badRequest('What should this be called?');
  if (name.length > 80) throw badRequest('That name is too long. Eighty characters is the limit.');
  if (!body.body?.trim()) throw badRequest('There is nothing to save.');

  return c.json({ query: saveQuery(service.id, name, body.body) }, 201);
});

browseRoutes.delete('/:id/queries/:queryId', (c) => {
  const query = findSavedQuery(c.req.param('queryId'));
  if (!query || query.serviceId !== c.req.param('id')) throw notFound('That saved query');
  deleteSavedQuery(query.id);
  return c.json({ ok: true });
});

/**
 * Copies of one database, taken often.
 *
 * Deliberately not called point-in-time recovery anywhere the person can see, because
 * it is not that: it restores the nearest copy at or before a moment, so what it
 * bounds is how much you lose rather than how precisely you can land.
 */
browseRoutes.get('/:id/snapshots', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  return c.json({
    snapshots: listSnapshots(service.id),
    everyHours: service.snapshotEveryHours ?? null,
    intervals: INTERVALS,
  });
});

browseRoutes.put('/:id/snapshots', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  if (service.kind !== 'database') throw badRequest('Only databases are copied this way.');

  const body = (await c.req.json().catch(() => ({}))) as { everyHours?: number | null };
  const hours = body.everyHours ?? null;
  if (hours !== null && !(INTERVALS as readonly number[]).includes(hours)) {
    throw badRequest(
      'Pick one of the intervals offered.',
      `Every ${INTERVALS.join(', ')} hours, or off.`,
    );
  }

  updateService(service.id, { snapshotEveryHours: hours });
  emitService(service.id);
  return c.json({ everyHours: hours });
});

browseRoutes.post('/:id/snapshots', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');

  const snapshot = await takeSnapshot(service.id);
  if (!snapshot) {
    throw badRequest(
      'Derailed could not read that database just now.',
      'It may still be starting, or its engine may not have a dump Derailed can take.',
    );
  }
  return c.json({ snapshot }, 201);
});

/**
 * Which copy would be used for a moment, without restoring it.
 *
 * Always the newest one at or before that moment, never a later one however much
 * closer it is: a copy from after the thing you are undoing contains the thing you
 * are undoing.
 */
browseRoutes.get('/:id/snapshots/at', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');
  const moment = Number(c.req.query('at') ?? Date.now());
  if (!Number.isFinite(moment)) throw badRequest('That is not a moment.');

  return c.json({ snapshot: snapshotAt(service.id, moment) });
});

browseRoutes.post('/:id/snapshots/:snapshotId/restore', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That database');

  // The snapshot restores into whichever database it belongs to, so the `:id` in the
  // URL was decorative: a mismatched pair quietly put the snapshot's own data back
  // rather than refusing. Make the two agree, so the address means what it says.
  const snapshotId = c.req.param('snapshotId');
  if (!listSnapshots(service.id).some((snapshot) => snapshot.id === snapshotId)) {
    throw notFound('That copy');
  }

  try {
    await restoreSnapshot(snapshotId);
  } catch (err) {
    throw badRequest(
      err instanceof Error ? err.message : 'That copy could not be put back.',
      err instanceof FriendlyError ? err.hint : undefined,
    );
  }
  return c.json({ ok: true });
});

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
