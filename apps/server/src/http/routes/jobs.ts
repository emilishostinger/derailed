import { type Context, Hono } from 'hono';
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
import { badRequest, notFound, readBody } from '../errors.ts';
import { requireOwnerFor } from '../permissions.ts';

export const jobRoutes = new Hono<AppEnv>();
export const serviceJobRoutes = new Hono<AppEnv>();

function withWords(job: ReturnType<typeof findJob>) {
  return job && { ...job, scheduleInWords: describeCron(job.schedule) };
}

/**
 * A job with no app named runs on the server itself, as a shell command, as whoever
 * Derailed runs as. That is an owner's business and nobody else's: it is a way to run
 * anything at all on the machine, which is a larger power than every owner-only rule
 * elsewhere put together.
 *
 * A job *inside* an app is the opposite, and stays a member's to make: it is the
 * migration or the nightly tidy-up that belongs to the app they already deploy.
 */
const SERVER_JOB_REASON =
  'Only an owner can schedule something on the server itself, because it can run anything.';

/** Lets anything through that names an app; stops everyone but an owner otherwise. */
function guardServerJob(c: Context<AppEnv>, serviceId: string | null): void {
  if (serviceId) return;
  requireOwnerFor(c.get('user').role, SERVER_JOB_REASON);
}

/**
 * Every job on the server, for the Jobs page.
 *
 * Server-level ones are left out for anybody who is not an owner, on the same grounds
 * as the API token list: a shell command written by an owner names paths, hosts and
 * sometimes credentials, and its stored output can contain anything at all on the
 * machine. Jobs inside an app are still listed to everyone, because they belong to the
 * app rather than to the server.
 */
jobRoutes.get('/', (c) => {
  const owner = c.get('user').role === 'owner';
  const jobs = listJobs().filter((job) => owner || job.serviceId);
  return c.json({ jobs: jobs.map((job) => withWords(job)) });
});

serviceJobRoutes.get('/:id/jobs', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  return c.json({ jobs: listJobs(service.id).map((job) => withWords(job)) });
});

jobRoutes.post('/', async (c) => {
  const body = (await readBody(c)) as {
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
  guardServerJob(c, body.serviceId ?? null);

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
  // The job that already exists, not the one being asked for: repointing an owner's
  // server job at a different command is the same power as writing one.
  guardServerJob(c, job.serviceId);

  const body = (await readBody(c)) as {
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
  guardServerJob(c, job.serviceId);
  deleteJob(job.id);
  return c.json({ ok: true });
});

/** Runs it now, whatever the schedule says. Also how a one-off task is done. */
jobRoutes.post('/:id/run', async (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');
  // Including running one somebody else wrote. The command is the owner's, but the
  // moment it runs is not nothing: this is the button that turns a line in a table
  // into a process on the machine.
  guardServerJob(c, job.serviceId);
  return c.json({ result: await runJob(job.id, 'manual') });
});

jobRoutes.get('/:id/runs', (c) => {
  const job = findJob(c.req.param('id'));
  if (!job) throw notFound('That job');
  guardServerJob(c, job.serviceId);
  return c.json({ runs: listRuns(job.id) });
});

/** What a schedule means, and when it would next fire. For the form's live preview. */
jobRoutes.post('/preview', async (c) => {
  const body = (await readBody(c)) as { schedule?: string };
  if (!body.schedule || !isValidCron(body.schedule)) {
    throw badRequest('That schedule is not one Derailed understands.');
  }
  return c.json({ inWords: describeCron(body.schedule), nextRunAt: nextRun(body.schedule) });
});
