/**
 * Who may do what.
 *
 * The policy is one function, so it can be asked directly rather than inferred from a
 * hundred requests. What matters here is not that the happy paths work but that the
 * refusals are refusals: a viewer that can write anything, or a member that can reach
 * the server itself, is the whole feature failing quietly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createSession, listSessionsForUser } from '../src/db/repo/sessions.ts';
import {
  countOwners,
  createUser,
  deleteUser,
  findUserById,
  listUsers,
  setRole,
} from '../src/db/repo/users.ts';
import { mayCall } from '../src/http/permissions.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'derailed-perms-'));
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('an owner', () => {
  test('may do anything, including the things nobody else may', () => {
    for (const [method, path] of [
      ['DELETE', '/api/projects/p1'],
      ['POST', '/api/people'],
      ['PATCH', '/api/system'],
      ['POST', '/api/updates/x/apply'],
      ['PUT', '/api/backups/offsite'],
      ['POST', '/api/trash/empty'],
    ] as const) {
      expect(mayCall('owner', method, path).ok).toBe(true);
    }
  });
});

describe('a viewer', () => {
  test('may read anything', () => {
    for (const path of ['/api/projects', '/api/services/s1/logs', '/api/system/stats']) {
      expect(mayCall('viewer', 'GET', path).ok).toBe(true);
    }
  });

  test('cannot read the owner-only lists either', () => {
    // The accounts on the server and the API tokens are worth keeping to owners: one
    // is who can get in, the other is a set of keys that each open everything.
    expect(mayCall('viewer', 'GET', '/api/people').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/tokens').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/backups/offsite').ok).toBe(false);
  });

  test('cannot read a live secret, even though it is a read', () => {
    // The "any read is fine" shortcut has an exception: a read that hands back a secret
    // rather than a view of one. A viewer is the role you give a client, and these two
    // come back in the clear.
    expect(mayCall('viewer', 'GET', '/api/services/s1/env').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/services/s1/connection').ok).toBe(false);
    // The archive is the most concentrated secret on the machine; downloading it is an
    // owner's, whatever the method.
    expect(mayCall('viewer', 'GET', '/api/backups/b1/download').ok).toBe(false);
    // But an ordinary read of the same app is still fine, or the role would be pointless.
    expect(mayCall('viewer', 'GET', '/api/services/s1').ok).toBe(true);
    expect(mayCall('viewer', 'GET', '/api/services/s1/logs').ok).toBe(true);
  });

  test('may change nothing at all, whatever the route', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of [
        '/api/projects',
        '/api/services/s1/restart',
        '/api/services/s1/env',
        '/api/services/s1/deployments',
        // A route that does not exist yet stands for the one added next Tuesday.
        '/api/something-invented-later',
      ]) {
        const decision = mayCall('viewer', method, path);
        expect(decision.ok).toBe(false);
        expect(decision.why).toContain('not change it');
      }
    }
  });
});

describe('a member', () => {
  test('runs the apps', () => {
    for (const [method, path] of [
      ['POST', '/api/services/s1/deployments'],
      ['POST', '/api/services/s1/restart'],
      ['POST', '/api/services/s1/stop'],
      ['PUT', '/api/services/s1/env'],
      ['POST', '/api/projects'],
      ['PATCH', '/api/projects/p1'],
      ['POST', '/api/services/s1/domains'],
      ['POST', '/api/backups'],
      ['POST', '/api/jobs'],
      ['PUT', '/api/services/s1/access'],
      ['POST', '/api/deployments/d1/rollback'],
    ] as const) {
      expect(mayCall('member', method, path).ok).toBe(true);
    }
  });

  test('cannot delete an app or a project', () => {
    expect(mayCall('member', 'DELETE', '/api/services/s1').ok).toBe(false);
    expect(mayCall('member', 'DELETE', '/api/projects/p1').ok).toBe(false);
  });

  test('but may still delete the things inside one', () => {
    // The rule is about the app itself, not everything that hangs off it. A member
    // who cannot remove a domain they just added is a member filing tickets.
    expect(mayCall('member', 'DELETE', '/api/domains/d1').ok).toBe(true);
    expect(mayCall('member', 'DELETE', '/api/jobs/j1').ok).toBe(true);
    expect(mayCall('member', 'DELETE', '/api/backups/b1').ok).toBe(true);
  });

  test('cannot touch the server itself', () => {
    for (const [method, path] of [
      ['PATCH', '/api/system'],
      ['POST', '/api/system/adopt'],
      ['POST', '/api/system/disk/reclaim'],
      ['PUT', '/api/system/panel-domain'],
      ['DELETE', '/api/system/free-domain'],
      ['POST', '/api/updates/x/apply'],
      ['POST', '/api/trash/t1/restore'],
      ['PUT', '/api/alerts/channels'],
      ['PATCH', '/api/mail'],
      ['PUT', '/api/backups/offsite'],
      ['POST', '/api/backups/move/export'],
      ['PUT', '/api/uptime/status-page'],
      // Choosing which addresses appear is the same decision as publishing the page:
      // an automatic address has the server's IP in it.
      ['PUT', '/api/uptime/d1/status-page'],
    ] as const) {
      expect(mayCall('member', method, path).ok).toBe(false);
    }
  });

  test('cannot decide who else is here, or mint a key that could', () => {
    expect(mayCall('member', 'POST', '/api/people').ok).toBe(false);
    expect(mayCall('member', 'GET', '/api/people').ok).toBe(false);
    // Reads included: a token stands in for an owner, so the list of them is the list
    // of keys to the machine.
    expect(mayCall('member', 'GET', '/api/tokens').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/tokens').ok).toBe(false);
  });

  test('cannot publish a database to the internet, download a backup, or restore one', () => {
    // Opening a port on the host and putting the engine on the public internet is the
    // machine, not the app. And the archive is every database in one file: taking it
    // off the server, or rolling a project back over what is live, are the owner's.
    expect(mayCall('member', 'POST', '/api/services/s1/expose').ok).toBe(false);
    expect(mayCall('member', 'GET', '/api/backups/b1/download').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/backups/b1/restore').ok).toBe(false);
    // Saving retention prunes across every project at once, so it is not a member's.
    expect(mayCall('member', 'PUT', '/api/backups/retention').ok).toBe(false);
  });

  test('may still make and delete an individual backup, and schedule one', () => {
    // The boundary is the data leaving or being written over, not the housekeeping.
    expect(mayCall('member', 'POST', '/api/backups').ok).toBe(true);
    expect(mayCall('member', 'DELETE', '/api/backups/b1').ok).toBe(true);
    expect(mayCall('member', 'PUT', '/api/backups/schedule').ok).toBe(true);
  });

  test('may still read the things it cannot change', () => {
    expect(mayCall('member', 'GET', '/api/system/stats').ok).toBe(true);
    expect(mayCall('member', 'GET', '/api/backups/offsite').ok).toBe(false);
    expect(mayCall('member', 'GET', '/api/alerts').ok).toBe(true);
    // The secrets a viewer is kept from are a member's to read: a member already holds
    // them, and needs them to do the job.
    expect(mayCall('member', 'GET', '/api/services/s1/env').ok).toBe(true);
    expect(mayCall('member', 'GET', '/api/services/s1/connection').ok).toBe(true);
  });
});

describe('the last owner', () => {
  test('cannot be demoted, or the server has nobody who can fix it', () => {
    const owner = createUser('owner@example.com', 'x', 'owner');
    expect(countOwners()).toBe(1);

    expect(setRole(owner.id, 'viewer')).toBe(false);
    expect(findUserById(owner.id)!.role).toBe('owner');
  });

  test('cannot be removed either', () => {
    const only = listUsers().find((person) => person.role === 'owner')!;
    expect(deleteUser(only.id)).toBe(false);
    expect(findUserById(only.id)).not.toBeNull();
  });

  test('can be demoted once somebody else is an owner', () => {
    const first = listUsers().find((person) => person.role === 'owner')!;
    const second = createUser('second@example.com', 'x', 'owner');
    expect(countOwners()).toBe(2);

    expect(setRole(first.id, 'member')).toBe(true);
    expect(findUserById(first.id)!.role).toBe('member');
    expect(countOwners()).toBe(1);

    // And now the remaining one is protected in their turn.
    expect(setRole(second.id, 'member')).toBe(false);
  });
});

describe('removing somebody', () => {
  test('takes their sessions with them', () => {
    const person = createUser('temp@example.com', 'x', 'member');
    createSession(person.id, 'a browser', '203.0.113.9');
    expect(listSessionsForUser(person.id)).toHaveLength(1);

    expect(deleteUser(person.id)).toBe(true);

    // The account being gone is not enough. A cookie that still opens the door is a
    // door that is still open.
    expect(listSessionsForUser(person.id)).toHaveLength(0);
    expect(findUserById(person.id)).toBeNull();
  });
});

describe('the first account', () => {
  test('is an owner without being asked', () => {
    // Every install that existed before this feature had exactly one account, and it
    // was the admin. Migrating them into anything less would lock them out.
    const solo = createUser('solo@example.com', 'x');
    expect(solo.role).toBe('owner');
  });
});
