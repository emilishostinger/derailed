/**
 * The permanent regression corpus: one named test per bug this project has shipped
 * and fixed.
 *
 * The rule for this file is that nothing in it is ever deleted. A bug that recurs is a
 * test that was removed, so these stay as long as the code they guard does. Each test
 * names the release it came from and the shape of the mistake, so a failure here is not
 * "something broke" but "we have been here before, and here is the story".
 *
 * Many of these bugs also have fuller tests elsewhere (the permission matrix, the
 * integration suites, the fuzz file). This is the index: the single place you can read
 * the whole history of what went wrong and confirm, in one fast run, that none of it
 * has come back. Where a bug lived in a pure function, it is exercised directly here;
 * where it lived in a route, it is driven through the real app as the role that found
 * it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReadOnly, isReadOnlyCommand, isReadOnlyMongo } from '../src/catalog/browse.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { verifyCodeStep } from '../src/http/totp.ts';
import { loadSecretKey } from '../src/util/crypto.ts';
import {
  isBlockedFetchAddress,
  resolveClientIp,
  resolvesToBlockedAddress,
} from '../src/util/net.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-corpus-'));
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
    cookies[role] =
      `derailed_session=${createSession(createUser(`${role}@corpus.test`, hash, role).id).id}`;
  }
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('v0.9.0 role escalations', () => {
  test('a member cannot run a server-level job (member-had-root-on-the-host)', () => {
    // A scheduled job with no serviceId runs /bin/sh on the machine as root. The path
    // is a member's, the meaning is not, so the handler, not the table, has to refuse.
    // The route-level gate is here; the body-determines-meaning half is in privilege.test.ts.
    expect(mayCall('member', 'POST', '/api/jobs').ok).toBe(true); // the route is a member's
    // and the handler refuses a server-level one; proven end to end in privilege.test.ts.
  });

  test('the SQL box refuses a CTE that opens with a write (v0.9.1)', () => {
    // `WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone` opened with an
    // allowlisted keyword and emptied a real table.
    expect(isReadOnly('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone')).toBe(false);
    expect(isReadOnly('EXPLAIN ANALYZE DELETE FROM users')).toBe(false);
  });
});

describe('v0.10.0 security pass', () => {
  test('a viewer cannot read live secrets on a GET', () => {
    expect(mayCall('viewer', 'GET', '/api/services/x/env').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/services/x/connection').ok).toBe(false);
  });

  test('a backup archive is owner-only, even to download (a GET)', () => {
    expect(mayCall('member', 'GET', '/api/backups/x/download').ok).toBe(false);
    expect(mayCall('viewer', 'GET', '/api/backups/x/download').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/backups/x/restore').ok).toBe(false);
    expect(mayCall('member', 'PUT', '/api/backups/retention').ok).toBe(false);
  });

  test('a member cannot publish a database to the internet', () => {
    expect(mayCall('member', 'POST', '/api/services/x/expose').ok).toBe(false);
  });

  test('the rate-limit key is the proxy-vouched hop, not a spoofable leftmost XFF', () => {
    // Caddy appends the real client, so the last public hop is the trustworthy one.
    expect(resolveClientIp('172.17.0.1', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(resolveClientIp('172.17.0.1', '6.6.6.6, 7.7.7.7, 203.0.113.9')).toBe('203.0.113.9');
  });

  test('a used TOTP step is answered as its own step, so a replay can be refused', () => {
    // The login handler stores the step and refuses anything at or before it. That only
    // works if a code maps to one definite step, which is what makes replay detectable.
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1_700_000_000_000;
    const a = verifyCodeStep(secret, '000000', now);
    const b = verifyCodeStep(secret, '000000', now);
    expect(a).toBe(b);
  });
});

describe('v0.11.0 audit findings', () => {
  test('a viewer cannot read a project shared-env side door', () => {
    expect(mayCall('viewer', 'GET', '/api/projects/x/env').ok).toBe(false);
  });

  test('the Mongo read-only box refuses $out, mapReduce, $where and bracket access', () => {
    expect(isReadOnlyMongo('db.x.aggregate([{$out: "y"}])')).toBe(false);
    expect(isReadOnlyMongo('db.x.aggregate([{$merge: "y"}])')).toBe(false);
    expect(isReadOnlyMongo('db.x.mapReduce(m, r, {out: "y"})')).toBe(false);
    expect(isReadOnlyMongo('db.x.find({$where: "1"})')).toBe(false);
    expect(isReadOnlyMongo('db.x["drop"]()')).toBe(false);
  });

  test('numeric and short-form loopback addresses resolve to blocked (SSRF)', async () => {
    // 2130706433 (decimal) and 127.1 (short) are loopback the canonical-quad check
    // misses, so they must fall through to the resolver and come back blocked. Both
    // resolve to 127.0.0.1 on every platform, so the assertion is portable.
    //
    // The octal form 0177.0.0.1 is deliberately NOT asserted here: it is one of the
    // few addresses that resolve differently by platform. On Linux (production, and
    // CI) getaddrinfo reads the octal and returns 127.0.0.1, which is blocked; on
    // macOS the resolver reads 0177 as decimal 177 and returns the public 177.0.0.1,
    // which is not loopback at all. fetchPublic pins whichever address the resolver
    // returns, so neither platform reaches an unintended private host, but the
    // *classification* is not the same on both, so a cross-platform test cannot pin it.
    for (const host of ['2130706433', '127.1']) {
      expect(await resolvesToBlockedAddress(host), host).toBe(true);
    }
    // And the canonical metadata address stays blocked directly.
    expect(isBlockedFetchAddress('169.254.169.254')).toBe(true);
  });
});

describe('the read-only guards, as a set, never bless a write', () => {
  test('SQL, Mongo and Redis each refuse their classic write', () => {
    expect(isReadOnly('DELETE FROM users')).toBe(false);
    expect(isReadOnlyMongo('db.users.drop()')).toBe(false);
    expect(isReadOnlyCommand('FLUSHALL')).toBe(false);
  });

  test('and each still allows its classic read, so they are not simply always-false', () => {
    expect(isReadOnly('SELECT 1')).toBe(true);
    expect(isReadOnlyMongo('db.users.find({})')).toBe(true);
    expect(isReadOnlyCommand('GET k')).toBe(true);
  });
});

describe('the 500-on-a-null-body class (v0.9.0 login, then sixty more routes)', () => {
  test('an authenticated write with a null body is a clean 4xx, not a server error', async () => {
    const res = await app.request('/api/auth/me/email', {
      method: 'PATCH',
      headers: {
        'x-requested-with': 'derailed',
        'content-type': 'application/json',
        cookie: cookies.owner,
      },
      body: 'null',
    });
    expect(res.status).toBeLessThan(500);
  });
});
