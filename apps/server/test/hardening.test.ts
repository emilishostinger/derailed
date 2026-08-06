/**
 * The ways in Derailed used to have, and no longer does.
 *
 * Every test here stands for something that was reachable: a socket a hostile page
 * could open, a control API every deployed container could talk to, a second admin
 * account created by asking twice at once. They are written as the attack rather than
 * as the fix, so that if the fix is ever undone by a refactor, the test says what was
 * lost rather than that a function changed shape.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemas, type Topic } from '@derailed/shared';
import { safeInside } from '../src/backup/backup.ts';
import { detectRepo } from '../src/build/detect.ts';
import { safeHealthPath } from '../src/build/pipeline.ts';
import { caddyAdminOverSocket } from '../src/config.ts';
import { initDb } from '../src/db/index.ts';
import { claimSetup, releaseSetup } from '../src/db/repo/settings.ts';
import { DockerError } from '../src/docker/client.ts';
import { createApp } from '../src/http/app.ts';
import { isSameOrigin } from '../src/http/auth.ts';
import { websocketHandlers } from '../src/http/ws.ts';
import { buildCaddyConfig } from '../src/proxy/caddy.ts';
import { explainDockerFailure } from '../src/system/status.ts';
import { loadSecretKey, randomSecret } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-hardening-'));
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
});

/**
 * A websocket handshake is exempt from CORS, and `SameSite=Lax` separates sites
 * rather than origins. An app deployed on `app.example.com` is the same site as a
 * dashboard on `panel.example.com`, so without this check the admin's cookie would
 * ride along on a socket opened by whatever that app chose to serve, and
 * `/api/terminal` would hand it a shell inside any container on the machine.
 */
describe('websocket handshakes only from the dashboard itself', () => {
  const handshake = (headers: Record<string, string>) =>
    new Request('http://panel.example.com/api/ws', { headers });

  test('accepts the dashboard', () => {
    expect(
      isSameOrigin(handshake({ host: 'panel.example.com', origin: 'https://panel.example.com' })),
    ).toBe(true);
  });

  test('refuses an app deployed on a sibling name, which is the same site', () => {
    expect(
      isSameOrigin(handshake({ host: 'panel.example.com', origin: 'https://app.example.com' })),
    ).toBe(false);
  });

  test('refuses another origin outright, and a sandboxed frame', () => {
    expect(
      isSameOrigin(handshake({ host: 'panel.example.com', origin: 'https://evil.test' })),
    ).toBe(false);
    expect(isSameOrigin(handshake({ host: 'panel.example.com', origin: 'null' }))).toBe(false);
  });

  test('refuses a name that only looks like ours', () => {
    expect(
      isSameOrigin(
        handshake({ host: 'panel.example.com', origin: 'https://panel.example.com.evil.test' }),
      ),
    ).toBe(false);
  });

  test('allows a client that sends no Origin, because no browser does that', () => {
    expect(isSameOrigin(handshake({ host: 'panel.example.com' }))).toBe(true);
  });
});

/**
 * Caddy's admin API can replace the whole proxy configuration and has no
 * authentication of its own. Caddy joins every project network so it can reach the
 * apps it proxies, so a TCP listener on it is one every deployed container can reach.
 */
describe('the proxy control API is not on the network', () => {
  test('listens on a unix socket wherever Derailed actually runs', () => {
    const config = buildCaddyConfig([]);
    if (caddyAdminOverSocket) {
      expect(config.admin.listen.startsWith('unix/')).toBe(true);
      expect(config.admin.listen).not.toContain('0.0.0.0');
    } else {
      // A development machine, where a socket across a Docker Desktop bind mount is
      // not dependable. The port is published to loopback only.
      expect(config.admin.listen).toStartWith('0.0.0.0:');
    }
  });
});

/**
 * Checking "is there an account yet?" and creating one are separated by reading a
 * body and hashing a password, both of which yield.
 */
describe('only one first account', () => {
  test('a second claim loses while the first is held', () => {
    expect(claimSetup()).toBe(true);
    expect(claimSetup()).toBe(false);
    releaseSetup();
    expect(claimSetup()).toBe(true);
    releaseSetup();
  });

  test('a claim left behind by a crash can be taken again', () => {
    expect(claimSetup()).toBe(true);
    // Nothing may take it while it is fresh, and anything may once it is stale.
    expect(claimSetup(60_000)).toBe(false);
    expect(claimSetup(-1)).toBe(true);
    releaseSetup();
  });

  test('two setups arriving together leave one account, not two', async () => {
    const setup = (email: string) =>
      app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery' }),
      });

    const [first, second] = await Promise.all([setup('one@example.com'), setup('two@example.com')]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([200, 409]);
  });
});

describe('hostnames', () => {
  test('accepts the shapes a certificate can be issued for', () => {
    expect(schemas.isHostname('example.com')).toBe(true);
    expect(schemas.isHostname('app.example.com')).toBe(true);
    expect(schemas.isHostname('my-app.example.co.uk')).toBe(true);
  });

  test('refuses the shapes the loose check used to wave through', () => {
    expect(schemas.isHostname('.example.com')).toBe(false);
    expect(schemas.isHostname('a..b.com')).toBe(false);
    expect(schemas.isHostname('-example.com')).toBe(false);
    expect(schemas.isHostname('example-.com')).toBe(false);
    expect(schemas.isHostname('example.com.')).toBe(false);
    expect(schemas.isHostname('example')).toBe(false);
    expect(schemas.isHostname(`${'a'.repeat(64)}.com`)).toBe(false);
    expect(schemas.isHostname(`${'a.'.repeat(200)}com`)).toBe(false);
  });
});

/**
 * The health path is concatenated onto `http://127.0.0.1:<port>`, so anything that
 * can move the host in that URL sends the check to a stranger's server, which then
 * gets to decide whether somebody's deploy succeeded.
 */
describe('health path stays a path', () => {
  test('keeps a real one', () => {
    expect(safeHealthPath('/healthz')).toBe('/healthz');
    expect(safeHealthPath('/')).toBe('/');
  });

  test('refuses anything that would re-point the address', () => {
    expect(safeHealthPath('@evil.test/')).toBe('/');
    expect(safeHealthPath('//evil.test/')).toBe('/');
    expect(safeHealthPath('https://evil.test')).toBe('/');
    expect(safeHealthPath('')).toBe('/');
    expect(safeHealthPath(null)).toBe('/');
  });

  test('and the schema refuses to store one', () => {
    expect(schemas.patchServiceRequest.safeParse({ healthPath: '@evil.test/' }).success).toBe(
      false,
    );
    expect(schemas.patchServiceRequest.safeParse({ healthPath: '/healthz' }).success).toBe(true);
  });
});

/** `rootDir` was kept inside the checkout. The setting right beside it was not. */
describe('the Dockerfile setting cannot leave the checkout', () => {
  test('a path climbing out of the repository finds nothing', async () => {
    const repo = join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'index.html'), '<h1>hi</h1>');
    // A real Dockerfile, outside the checkout, that the setting points at.
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\nEXPOSE 9999\n');

    const result = await detectRepo({ dir: repo, dockerfilePath: '../Dockerfile' });
    expect(result.dockerfilePath).toBe(null);
    expect(result.strategy).not.toBe('dockerfile');
  });

  test('one inside it is still found', async () => {
    const repo = join(dir, 'repo-with-dockerfile');
    await mkdir(join(repo, 'docker'), { recursive: true });
    await writeFile(join(repo, 'docker', 'Dockerfile'), 'FROM scratch\nEXPOSE 8080\n');

    const result = await detectRepo({ dir: repo, dockerfilePath: 'docker/Dockerfile' });
    expect(result.dockerfilePath).toBe('docker/Dockerfile');
    expect(result.port).toBe(8080);
  });
});

/**
 * The type says the topics are an array of strings. The socket says they are whatever
 * the other end typed, and an exception thrown here leaves Bun's handler with nothing
 * waiting to catch it.
 */
describe('malformed websocket messages', () => {
  function socket() {
    const sent: string[] = [];
    return {
      sent,
      ws: {
        data: { kind: 'events' as const, userId: 'u', topics: new Set<Topic>() },
        send: (value: string) => sent.push(value),
        close: () => undefined,
      },
    };
  }

  /** Enough of a `ServerWebSocket` for the handler, without dragging Bun's type in. */
  const asSocket = (ws: ReturnType<typeof socket>['ws']) =>
    ws as unknown as Parameters<typeof websocketHandlers.message>[0];

  test('survives topics that are not a list', () => {
    const { ws } = socket();
    for (const body of [
      '{"type":"subscribe","topics":7}',
      '{"type":"subscribe"}',
      '{"type":"subscribe","topics":"system"}',
      '{"type":"unsubscribe","topics":null}',
      '{"type":"subscribe","topics":[1,2,{}]}',
      'not json at all',
      '[]',
    ]) {
      expect(() => websocketHandlers.message(asSocket(ws), body)).not.toThrow();
    }
  });

  test('still subscribes when the message is the right shape', () => {
    const { ws } = socket();
    websocketHandlers.message(asSocket(ws), '{"type":"subscribe","topics":["system","p:1"]}');
    expect([...ws.data.topics]).toEqual(['system', 'p:1'] as Topic[]);
  });
});

describe('generated secrets', () => {
  test('are the length asked for, from the alphabet, every time', () => {
    for (const length of [1, 16, 32, 48]) {
      const secret = randomSecret(length);
      expect(secret).toHaveLength(length);
      expect(secret).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  test('do not lean on the first eight letters the way `% 62` did', () => {
    // 256 % 62 is 8, so a plain remainder draws A-H about 1.25 times as often as the
    // rest. Over this many samples that bias is far outside the noise.
    const counts = new Map<string, number>();
    const sample = randomSecret(60_000);
    for (const character of sample) counts.set(character, (counts.get(character) ?? 0) + 1);

    const biased = 'ABCDEFGH';
    const early = [...biased].reduce((total, c) => total + (counts.get(c) ?? 0), 0) / biased.length;
    const rest = (sample.length - early * biased.length) / (62 - biased.length);
    expect(early / rest).toBeGreaterThan(0.9);
    expect(early / rest).toBeLessThan(1.1);
  });
});

/**
 * Found by running the release binary against a Docker old enough to refuse it, which
 * is what a distribution package still installs.
 */
describe('why Docker is not answering', () => {
  test('an old daemon is named as old, rather than quoting API versions back', () => {
    const message = explainDockerFailure(
      new DockerError(
        400,
        'client version 1.44 is too new. Maximum supported API version is 1.41',
        '/version',
      ),
    );
    expect(message).toContain('too old');
    expect(message).toContain('Docker 25');
    expect(message).not.toContain('1.44');
  });

  test('a permissions problem says what to do about it', () => {
    const message = explainDockerFailure(
      new DockerError(
        403,
        'permission denied while trying to connect to the Docker daemon socket',
        '/version',
      ),
    );
    expect(message).toContain('root');
  });

  test('anything else is passed through rather than invented', () => {
    expect(explainDockerFailure(new DockerError(500, 'something specific', '/version'))).toBe(
      'something specific',
    );
    expect(explainDockerFailure(new Error('nope'))).toContain('Is the Docker service running?');
  });
});

/** A backup is a file. It can be edited, and it can arrive from somewhere else. */
describe('paths named inside a backup manifest', () => {
  test('stay inside the unpacked folder', () => {
    expect(safeInside('/tmp/restore', 'databases/blog-dump.sql')).toBe(
      '/tmp/restore/databases/blog-dump.sql',
    );
    expect(safeInside('/tmp/restore', '../../etc/shadow')).toBe(null);
    expect(safeInside('/tmp/restore', '/etc/shadow')).toBe('/tmp/restore/etc/shadow');
    expect(safeInside('/tmp/restore', '')).toBe(null);
  });
});
