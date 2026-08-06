import { Hono } from 'hono';
import { findService } from '../../db/repo/services.ts';
import {
  createJob,
  deleteJob,
  findJob,
  listJobs,
  listRuns,
  runJob,
  updateJob,
} from '../../jobs/run.ts';
import { describeCron, isValidCron, nextRun } from '../../jobs/schedule.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const jobRoutes = new Hono<AppEnv>();
export const serviceJobRoutes = new Hono<AppEnv>();

function withWords(job: ReturnType<typeof findJob>) {
  return job && { ...job, scheduleInWords: describeCron(job.schedule) };
}

/** Every job on the server, for the Jobs page. */
jobRoutes.get('/', (c) => c.json({ jobs: listJobs().map((job) => withWords(job)) }));

serviceJobRoutes.get('/:id/jobs', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ jobs: listJobs(service.id).map((job) => withWords(job)) });
});

jobRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    serviceId?: string | null;
    name?: string;
    command?: string;
    schedule?: string;
  };

  if (!body.name?.trim()) throw badRequest('Give it a name, so the list makes sense later.');
  if (!body.command?.trim()) throw badRequest('There is nothing to run.');
  if (!body.schedule || !isValidCron(body.schedule)) {
    throw badRequest(
      'That schedule is not one Derailed understands.',
      'Pick one of the ready-made ones, or write five cron fields: minute, hour, day, month, weekday.',
    );
  }
  // A job attached to nothing runs on the server itself, which is deliberate and
  // different. A job naming an app that does not exist is a mistake.
  if (body.serviceId && !findService(body.serviceId)) throw notFound('That app');

  const job = createJob({
    serviceId: body.serviceId ?? null,
    name: body.name.trim(),
    command: body.command.trim(),
    schedule: body.schedule,
  });
  return c.json({ job: withWords(job) }, 201);
});

jobRoutes.patch('/:id', async (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    command?: string;
    schedule?: string;
    enabled?: boolean;
  };
  if (body.schedule !== undefined && !isValidCron(body.schedule)) {
    throw badRequest('That schedule is not one Derailed understands.');
  }
  return c.json({ job: withWords(updateJob(job.id, body)) });
});

jobRoutes.delete('/:id', (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');
  deleteJob(job.id);
  return c.json({ ok: true });
});

/** Runs it now, whatever the schedule says. Also how a one-off task is done. */
jobRoutes.post('/:id/run', async (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');
  return c.json({ result: await runJob(job.id, 'manual') });
});

jobRoutes.get('/:id/runs', (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');
  return c.json({ runs: listRuns(job.id) });
});

/** What a schedule means, and when it would next fire. For the form's live preview. */
jobRoutes.post('/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { schedule?: string };
  if (!body.schedule || !isValidCron(body.schedule)) {
    throw badRequest('That schedule is not one Derailed understands.');
  }
  return c.json({ inWords: describeCron(body.schedule), nextRunAt: nextRun(body.schedule) });
});
