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
import { createProject } from '../src/db/repo/projects.ts';
import { createDatabaseService } from '../src/db/repo/services.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
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

/**
 * A backup archive is every database in the project, in one downloadable file, and
 * restoring one writes over what is live. Making and deleting them is a member's job;
 * the data leaving the machine, or landing back on it, is not. These go through the real
 * app as the wrong role and stop at the door, before any handler or file is touched.
 */
describe('the data inside a backup', () => {
  test('cannot be downloaded by a viewer or a member', async () => {
    for (const who of ['viewer', 'member'] as const) {
      const response = await call(who, 'GET', '/api/backups/any-id/download');
      expect(response.status).toBe(403);
    }
  });

  test('cannot be restored, and retention cannot be set, by a member', async () => {
    expect((await call('member', 'POST', '/api/backups/any-id/restore')).status).toBe(403);
    expect((await call('member', 'PUT', '/api/backups/retention', { keep: 1 })).status).toBe(403);
  });

  test('but making and deleting one is still a member’s', async () => {
    // Not the owner-only door: a member reaches the handler (and gets a 404 for the
    // made-up id), which is the boundary landing where it should.
    expect((await call('member', 'DELETE', '/api/backups/any-id')).status).not.toBe(403);
  });
});

/**
 * Publishing a database maps a host port and puts the engine on the public internet, and
 * a viewer reading a connection string or an app's variables walks out with live
 * secrets. Both were reachable by the wrong role until the table learned about them.
 */
describe('secrets and the public internet', () => {
  test('a member cannot expose a database', async () => {
    // The refusal is at the door, before the handler that would recreate the container,
    // so a made-up id is enough to prove the boundary and needs no Docker.
    const response = await call('member', 'POST', '/api/services/any-id/expose', { exposed: true });
    expect(response.status).toBe(403);
  });

  test('a viewer cannot read variables or a connection string', async () => {
    expect((await call('viewer', 'GET', '/api/services/any-id/env')).status).toBe(403);
    expect((await call('viewer', 'GET', '/api/services/any-id/connection')).status).toBe(403);
    // A member may: they already hold these and need them to do the job.
    expect((await call('member', 'GET', '/api/services/any-id/env')).status).not.toBe(403);
  });
});

/**
 * The file browser reaches an app's storage, and a database keeps its data in storage
 * registered exactly the same way. So without a guard a member could delete the files
 * under a running Postgres, the irreversible loss the owner-only volume rule is there to
 * prevent, and a viewer could stream the database out a file at a time. The browser is
 * for apps; a database is refused before the path is ever resolved.
 */
describe("a database's files on disk", () => {
  function aDatabase(): string {
    const project = createProject('data');
    const service = createDatabaseService({
      projectId: project.id,
      name: 'pg',
      engine: 'postgres',
      version: '16',
      dbName: 'app',
      dbUser: 'app',
      dbPassword: 'secret',
      port: 5432,
    });
    // Its data directory, registered as storage just like an app's would be.
    createVolume(service.id, '/var/lib/postgresql/data');
    return service.id;
  }

  test('are not browsable, readable, downloadable or deletable, by anyone', async () => {
    const id = aDatabase();
    const p = '/var/lib/postgresql/data';
    // The message matters, not just the 400: a handler that reached the container and
    // found none also answers 400, so the test insists on the guard's own words, which
    // is what proves the request was turned away before any path was resolved.
    const refused = /file browser is for apps/i;
    for (const who of ['owner', 'member', 'viewer'] as const) {
      const browse = await call(who, 'GET', `/api/services/${id}/files?path=${p}`);
      expect(browse.status).toBe(400);
      expect((await json(browse)).error.message).toMatch(refused);

      const download = await call(
        who,
        'GET',
        `/api/services/${id}/files/download?path=${p}/PG_VERSION`,
      );
      expect((await json(download)).error.message).toMatch(refused);
    }
    // The mutating one is the sharper half: no wiping the database this way.
    const wipe = await call('member', 'DELETE', `/api/services/${id}/files?path=${p}/base`);
    expect(wipe.status).toBe(400);
    expect((await json(wipe)).error.message).toMatch(refused);
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

  test('cannot be restored either, and says 404 rather than a 400 from deep inside', async () => {
    // The delete route already answered 404 for a missing id; restore reached into the
    // restore machinery and surfaced a 400. The two now agree.
    const response = await call('owner', 'POST', '/api/backups/no-such-backup/restore', {
      projectId: 'whatever',
    });
    expect(response.status).toBe(404);
  });
});
