import { Hono } from 'hono';
import { findService } from '../../db/repo/services.ts';
import {
  createVolume,
  deleteVolume,
  findVolume,
  listVolumesFor,
  pathInUse,
} from '../../db/repo/volumes.ts';
import { removeVolume } from '../../docker/volumes.ts';
import { emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, conflict, notFound, readBody } from '../errors.ts';

export const serviceVolumeRoutes = new Hono<AppEnv>();
export const volumeRoutes = new Hono<AppEnv>();

serviceVolumeRoutes.get('/:id/volumes', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ volumes: listVolumesFor(service.id) });
});

serviceVolumeRoutes.post('/:id/volumes', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'app') {
    throw badRequest(
      'Databases already keep their data. You only need this for apps.',
      "A database's storage is set up for you when it's created.",
    );
  }

  const body = (await readBody(c)) as { containerPath?: string };
  const containerPath = body.containerPath?.trim();

  if (!containerPath?.startsWith('/')) {
    throw badRequest(
      'That needs to be a folder path inside the app, starting with a slash.',
      'For example /var/www/html/wp-content for WordPress uploads.',
    );
  }
  // Mounting over these replaces the operating system's own files and the container
  // won't start. A confusing way to lose an afternoon.
  if (/^\/(bin|sbin|lib|lib64|etc|proc|sys|dev|boot|usr)\/?$/.test(containerPath)) {
    throw badRequest(
      `${containerPath} is part of the system inside the app, so it can't be used for storage.`,
      'Pick a folder your app writes to, like /data or /app/uploads.',
    );
  }
  if (pathInUse(service.id, containerPath)) {
    throw conflict(`${containerPath} already has storage attached.`);
  }

  const volume = createVolume(service.id, containerPath);
  emitService(service.id);
  return c.json({ volume }, 201);
});

/**
 * Deleting storage destroys the data in it. The container keeps running with the
 * volume still mounted until the next deploy, which is the honest behaviour. We
 * don't restart someone's app out from under them.
 */
volumeRoutes.delete('/:id', async (c) => {
  const volume = findVolume(c.req.param('id'));
  if (!volume) throw notFound('That storage');

  deleteVolume(volume.id);
  // Best effort: still in use by the running container until it's replaced.
  await removeVolume(volume.name).catch(() => undefined);
  emitService(volume.serviceId);
  return c.json({ ok: true });
});
