/**
 * The boundary a role is supposed to be.
 *
 * `permissions.test.ts` asks the policy function directly, which is the right way to
 * check the table of rules. These tests go through the actual HTTP app instead,
 * because the two holes they cover were not in the table at all: one lived in a
 * handler that the table cannot see into, and one was a route the table simply did
 * not mention.
 *
 * Both were found by driving a running server as a member and watching it do things a
 * member is documented as unable to do.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-privilege-'));
let app: ReturnType<typeof createApp>;
const cookies: Record<'owner' | 'member' | 'viewer', string> = {
  owner: '',
  member: '',
  viewer: '',
};

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();

  const hash = await Bun.password.hash('correct-horse');
  for (const role of ['owner', 'member', 'viewer'] as const) {
    const user = createUser(`${role}@example.com`, hash, role);
    cookies[role] = `derailed_session=${createSession(user.id).id}`;
  }
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

type Json = Record<string, any>;

/** The bodies here are test fixtures, so reading them loosely is the point. */
async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

async function call(
  who: 'owner' | 'member' | 'viewer',
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      'x-requested-with': 'derailed',
      'content-type': 'application/json',
      cookie: cookies[who],
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

/**
 * A job with no app named runs `/bin/sh -c` on the server itself, as whoever Derailed
 * runs as, which on a real install is root. Nothing in the rules table could see that,
 * because the difference between "run this in my app's container" and "run this on the
 * machine" is one field in the body, and the table matches on paths.
 *
 * So a member could ask for a job with no `serviceId`, press Run, and read the output
 * of any command they liked: the database file, the secret key, `useradd`. Every
 * owner-only rule elsewhere was a formality while this was open.
 */
describe('a job that runs on the server itself', () => {
  const serverJob = {
    serviceId: null,
    name: 'probe',
    command: 'id',
    schedule: '0 5 * * *',
  };

  test('cannot be created by a member', async () => {
    const response = await call('member', 'POST', '/api/jobs', serverJob);
    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toContain('server itself');
  });

  test('cannot be created by a viewer either', async () => {
    expect((await call('viewer', 'POST', '/api/jobs', serverJob)).status).toBe(403);
  });

  test('can still be created by an owner', async () => {
    const response = await call('owner', 'POST', '/api/jobs', serverJob);
    expect(response.status).toBe(201);
  });

  test('cannot be repointed at another command by a member', async () => {
    const made = await call('owner', 'POST', '/api/jobs', { ...serverJob, name: 'tidy' });
    const { job } = await json(made);

    const hijack = await call('member', 'PATCH', `/api/jobs/${job.id}`, {
      command: 'cat /var/lib/derailed/secret.key',
    });
    expect(hijack.status).toBe(403);

    // And the command really is untouched, not merely refused on the way in.
    const after = await call('owner', 'GET', '/api/jobs');
    const stored = (await json(after)).jobs.find((entry: { id: string }) => entry.id === job.id);
    expect(stored.command).toBe('id');
  });

  test('cannot be run on demand by a member', async () => {
    const made = await call('owner', 'POST', '/api/jobs', { ...serverJob, name: 'run-probe' });
    const { job } = await json(made);
    expect((await call('member', 'POST', `/api/jobs/${job.id}/run`)).status).toBe(403);
    expect((await call('member', 'DELETE', `/api/jobs/${job.id}`)).status).toBe(403);
  });

  test('does not appear in the list, or hand over its output, to a member', async () => {
    await call('owner', 'POST', '/api/jobs', { ...serverJob, name: 'secret-ish' });

    const mine = await call('member', 'GET', '/api/jobs');
    const jobs = (await json(mine)).jobs as { serviceId: string | null }[];
    expect(jobs.every((job) => job.serviceId !== null)).toBe(true);

    const all = await call('owner', 'GET', '/api/jobs');
    const [first] = (await json(all)).jobs as { id: string }[];
    expect(first).toBeTruthy();
    expect((await call('member', 'GET', `/api/jobs/${first?.id}/runs`)).status).toBe(403);
  });

  test("a job inside an app is still a member's to make", async () => {
    // The point of the fix is a boundary, not a wall: the migration that runs in the
    // container an app already owns is exactly what a member is for.
    const project = await json(await call('owner', 'POST', '/api/projects', { name: 'jobs' }));
    const service = await json(
      await call('owner', 'POST', `/api/projects/${project.project.id}/services`, {
        kind: 'app',
        name: 'app',
        source: 'image',
        image: 'nginx:alpine',
        port: 80,
      }),
    );

    const response = await call('member', 'POST', '/api/jobs', {
      serviceId: service.service.id,
      name: 'migrate',
      command: 'echo hello',
      schedule: '0 6 * * *',
    });
    expect(response.status).toBe(201);
  });
});

/**
 * Storage outlives the app attached to it. Deleting the app was already an owner's
 * decision; deleting the volume underneath it was not on the list at all, so a member
 * could throw away the database while being unable to remove the app in front of it.
 */
describe('storage', () => {
  test('cannot be deleted by a member', async () => {
    const project = await json(await call('owner', 'POST', '/api/projects', { name: 'vols' }));
    const service = await json(
      await call('owner', 'POST', `/api/projects/${project.project.id}/services`, {
        kind: 'app',
        name: 'vol-app',
        source: 'image',
        image: 'nginx:alpine',
        port: 80,
      }),
    );
    const created = await json(
      await call('owner', 'POST', `/api/services/${service.service.id}/volumes`, {
        containerPath: '/data',
        name: 'data',
      }),
    );
    const volume = created.volume ?? created.volumes?.at(-1);
    expect(volume?.id).toBeTruthy();

    const response = await call('member', 'DELETE', `/api/volumes/${volume.id}`);
    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toContain('does not come back');
  });
});

/** Saying "deleted" about something that was never there is the wrong answer. */
describe('a backup that is not there', () => {
  test('is a 404 rather than a cheerful ok', async () => {
    const response = await call('owner', 'DELETE', '/api/backups/no-such-backup');
    expect(response.status).toBe(404);
  });

  test('and an id that tries to walk out of the folder is refused', async () => {
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '..', 'a%2Fb']) {
      const response = await call('owner', 'DELETE', `/api/backups/${id}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });
});
