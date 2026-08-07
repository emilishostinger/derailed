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
import { drillBackup, lastDrill } from '../../backup/drill.ts';
import { describeInstall, exportInstall, importInstall } from '../../backup/migrate.ts';
import {
  copyOffsite,
  forgetOffsiteSettings,
  offsiteSettings,
  offsiteStatus,
  pruneOffsite,
  type SaveOffsiteInput,
  saveOffsiteSettings,
  testOffsite,
} from '../../backup/offsite.ts';
import { S3Error } from '../../backup/s3.ts';
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

  // A copy made by hand goes off-site too, and a failure here is reported rather than
  // thrown: the backup itself succeeded, and saying otherwise would be wrong.
  let offsite: { sizeBytes: number } | null = null;
  let offsiteError: string | null = null;
  try {
    offsite = await copyOffsite(backup.id);
  } catch (err) {
    offsiteError = err instanceof Error ? err.message : 'The copy off this server failed.';
  }
  await pruneOffsite(retention().keep).catch(() => undefined);

  return c.json({ backup, offsite, offsiteError }, 201);
});

backupRoutes.get('/offsite', async (c) =>
  c.json({ settings: offsiteSettings(), status: await offsiteStatus() }),
);

/**
 * Where backups are copied to. Saving does not test it: testing is a separate button,
 * because a form that refuses to save until the credentials work is one you cannot
 * fill in over two sittings.
 */
backupRoutes.put('/offsite', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<SaveOffsiteInput>;
  if (!body.endpoint?.trim() || !body.bucket?.trim() || !body.accessKeyId?.trim()) {
    throw badRequest('An address, a bucket and an access key are all needed.');
  }
  if (!body.secretAccessKey?.trim() && !offsiteSettings().hasSecret) {
    throw badRequest('The secret key is needed too.');
  }

  saveOffsiteSettings({
    endpoint: body.endpoint,
    bucket: body.bucket,
    region: body.region ?? 'us-east-1',
    accessKeyId: body.accessKeyId,
    secretAccessKey: body.secretAccessKey,
    prefix: body.prefix,
    pathStyle: body.pathStyle,
  });
  return c.json({ settings: offsiteSettings(), status: await offsiteStatus() });
});

backupRoutes.delete('/offsite', async (c) => {
  forgetOffsiteSettings();
  return c.json({ settings: offsiteSettings(), status: await offsiteStatus() });
});

/** Writes a file, reads it back, compares it, deletes it. All four are permissions. */
backupRoutes.post('/offsite/test', async (c) => {
  try {
    return c.json({ result: await testOffsite() });
  } catch (err) {
    if (err instanceof S3Error) throw badRequest(err.message, err.hint);
    throw err;
  }
});

/**
 * Moving to another server.
 *
 * Export builds one file with everything Derailed knows plus a backup of every
 * project. Import recreates the shape of it and starts nothing.
 */
backupRoutes.get('/move/plan', (c) => c.json({ plan: describeInstall() }));

backupRoutes.post('/move/export', async (c) => {
  const { file, sizeBytes } = await exportInstall();
  return c.json({ file: file.split('/').pop(), sizeBytes });
});

backupRoutes.post('/move/import', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { plan?: unknown };
  if (!body.plan || typeof body.plan !== 'object') {
    throw badRequest('That does not look like a Derailed file.');
  }
  try {
    return c.json({ result: importInstall(body.plan as Parameters<typeof importInstall>[0]) });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'That file could not be read.');
  }
});

backupRoutes.get('/drill', (c) => c.json({ drill: lastDrill() }));

/** Checks a backup can actually be read back. The newest one unless told otherwise. */
backupRoutes.post('/drill', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { backupId?: string };
  const id = body.backupId ?? (await listBackups())[0]?.id;
  if (!id) throw badRequest('There are no backups to check yet.');
  return c.json({ drill: await drillBackup(id) });
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
  const id = c.req.param('id');
  // `rm -f` semantics underneath, so without this every id answered "ok" whether or
  // not it named anything. On the one screen whose job is to say what copies still
  // exist, "deleted" about something that was never there is the wrong answer.
  if (!(await Bun.file(backupFile(id)).exists())) throw notFound('That backup');
  await deleteBackup(id);
  return c.json({ ok: true });
});
