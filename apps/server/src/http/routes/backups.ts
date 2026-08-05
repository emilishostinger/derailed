import { Hono } from 'hono';
import {
  backupFile,
  createBackup,
  deleteBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  retention,
  setRetention,
} from '../../backup/backup.ts';
import { lastRunAt, nextRunAt, setProjectSchedule } from '../../backup/schedule.ts';
import { findProject, listProjects } from '../../db/repo/projects.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const backupRoutes = new Hono<AppEnv>();

backupRoutes.get('/', async (c) =>
  c.json({
    backups: await listBackups(),
    retention: retention(),
    schedules: listProjects().map((project) => ({
      projectId: project.id,
      projectName: project.name,
      schedule: project.backupSchedule,
    })),
    lastRunAt: lastRunAt(),
    nextRunAt: nextRunAt(),
  }),
);

/** One project at a time: "back up everything" is rarely what someone means. */
backupRoutes.put('/schedule', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: string;
    schedule?: string;
  };
  if (!body.projectId || !findProject(body.projectId)) throw notFound('That project');
  const schedule = body.schedule;
  if (schedule !== 'off' && schedule !== 'daily' && schedule !== 'weekly') {
    throw badRequest('Choose off, daily or weekly.');
  }
  setProjectSchedule(body.projectId, schedule);
  return c.json({ projectId: body.projectId, schedule, nextRunAt: nextRunAt() });
});

backupRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
  if (!body.projectId) throw badRequest('Which project should be backed up?');
  if (!findProject(body.projectId)) throw notFound('That project');
  const backup = await createBackup(body.projectId);
  // Applies to copies made by hand as well, or "keep three" would only mean the
  // scheduled ones and the disk would still fill up.
  await pruneBackups().catch(() => undefined);
  return c.json({ backup }, 201);
});

backupRoutes.get('/retention', (c) => c.json({ retention: retention() }));

backupRoutes.put('/retention', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { keep?: number; keepDays?: number };
  const keep = Number(body.keep);
  const keepDays = Number(body.keepDays ?? 0);
  if (!Number.isFinite(keep) || keep < 1 || keep > 100) {
    throw badRequest('Keep between 1 and 100 copies of each project.');
  }
  if (!Number.isFinite(keepDays) || keepDays < 0 || keepDays > 3650) {
    throw badRequest('An age limit has to be between 1 and 3650 days, or none at all.');
  }
  const saved = setRetention({ keep, keepDays });
  const removed = await pruneBackups(saved).catch(() => 0);
  return c.json({ retention: saved, removed });
});

/** Streams the archive so it can be kept somewhere that isn't this server. */
backupRoutes.get('/:id/download', async (c) => {
  const file = Bun.file(backupFile(c.req.param('id')));
  if (!(await file.exists())) throw notFound('That backup');
  return new Response(file, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${c.req.param('id')}.tar.gz"`,
    },
  });
});

backupRoutes.post('/:id/restore', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string };
  if (!body.projectId) throw badRequest('Which project should this be restored into?');
  const report = await restoreBackup(c.req.param('id'), body.projectId);
  return c.json({ report });
});

backupRoutes.delete('/:id', async (c) => {
  await deleteBackup(c.req.param('id'));
  return c.json({ ok: true });
});
