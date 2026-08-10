/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${VAR} strings here
   are Docker Compose interpolation syntax under test, not mistaken JS templates. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { findService, listServices } from '../src/db/repo/services.ts';
import { listVolumesFor } from '../src/db/repo/volumes.ts';
import { applyImportPlan } from '../src/import/apply.ts';
import {
  interpolate,
  memoryToMb,
  parseCompose,
  shellwords,
  startOrder,
} from '../src/import/compose.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * A compose file read once and turned into ordinary services. The parser's job
 * is to be honest: what it can honour becomes the plan, what it cannot becomes
 * a sentence, and nothing quietly means something else.
 */

function services(text: string, env: Record<string, string> = {}) {
  return parseCompose(text, { env });
}

describe('what a file must have', () => {
  test('valid YAML, said plainly when it is not', () => {
    expect(() => services('services: [}')).toThrow('not valid YAML');
  });

  test('at least one service', () => {
    expect(() => services('volumes: {}')).toThrow('no services');
    expect(() => services('')).toThrow();
  });

  test('a service needs an image or a build', () => {
    const reading = services(
      ['services:', '  ghost:', '    restart: always', '  web:', '    image: nginx:alpine'].join(
        '\n',
      ),
    );
    expect(reading.services.map((s) => s.name)).toEqual(['web']);
    expect(reading.warnings.join(' ')).toContain('neither an image nor a build');
  });
});

describe('the shapes environment comes in', () => {
  test('map form and array form read the same', () => {
    const map = services(
      ['services:', '  a:', '    image: x:1', '    environment:', '      KEY: value'].join('\n'),
    );
    const array = services(
      ['services:', '  a:', '    image: x:1', '    environment:', '      - KEY=value'].join('\n'),
    );
    expect(map.services[0]!.env).toEqual([{ key: 'KEY', value: 'value' }]);
    expect(array.services[0]!.env).toEqual([{ key: 'KEY', value: 'value' }]);
  });

  test('a bare name would inherit from the host, which is not here', () => {
    const reading = services(
      ['services:', '  a:', '    image: x:1', '    environment:', '      - SECRET'].join('\n'),
    );
    expect(reading.services[0]!.env).toEqual([{ key: 'SECRET', value: '' }]);
    expect(reading.warnings.join(' ')).toContain('SECRET');
  });

  test('${VARIABLES} are filled from the .env beside the file', () => {
    const reading = parseCompose(
      [
        'services:',
        '  a:',
        '    image: "postgres:${PG_VERSION:-16}"',
        '    environment:',
        '      URL: "db://${DB_HOST}:5432"',
        '      MISSING: "${NOWHERE}"',
      ].join('\n'),
      { env: { DB_HOST: 'db' } },
    );
    const byKey = Object.fromEntries(reading.services[0]!.env.map((e) => [e.key, e.value]));
    expect(reading.services[0]!.image).toBe('postgres:16');
    expect(byKey.URL).toBe('db://db:5432');
    expect(byKey.MISSING).toBe('');
    expect(reading.warnings.join(' ')).toContain('NOWHERE');
  });
});

describe('interpolation, the compose dialect', () => {
  const env = { NAME: 'shop', EMPTY: '' };
  const quiet = () => undefined;

  test('the five forms', () => {
    expect(interpolate('$NAME', env, quiet, 'x')).toBe('shop');
    expect(interpolate('${NAME}', env, quiet, 'x')).toBe('shop');
    expect(interpolate('${MISSING:-fallback}', env, quiet, 'x')).toBe('fallback');
    expect(interpolate('${EMPTY:-fallback}', env, quiet, 'x')).toBe('fallback');
    expect(interpolate('${EMPTY-fallback}', env, quiet, 'x')).toBe('');
    expect(interpolate('a $$literal', env, quiet, 'x')).toBe('a $literal');
  });
});

describe('ports become one web port', () => {
  test('short forms, long forms, and the database ports nobody wants a domain on', () => {
    const reading = services(
      [
        'services:',
        '  a:',
        '    image: x:1',
        '    ports:',
        '      - "5432:5432"',
        '      - "127.0.0.1:8080:80"',
        '  b:',
        '    image: y:1',
        '    ports:',
        '      - target: 3000',
        '        published: 9000',
      ].join('\n'),
    );
    expect(reading.services[0]!.port).toBe(80);
    expect(reading.services[1]!.port).toBe(3000);
  });

  test('udp is said, not silently dropped', () => {
    const reading = services(
      ['services:', '  a:', '    image: x:1', '    ports:', '      - "514:514/udp"'].join('\n'),
    );
    expect(reading.services[0]!.port).toBeNull();
    expect(reading.warnings.join(' ')).toContain('UDP');
  });
});

describe('volumes become storage', () => {
  test('named, anonymous and bound folders all land on the container path', () => {
    const reading = services(
      [
        'volumes:',
        '  data:',
        'services:',
        '  a:',
        '    image: x:1',
        '    volumes:',
        '      - data:/var/lib/data',
        '      - ./local:/srv/files',
        '      - /var/cache/thing',
      ].join('\n'),
    );
    expect(reading.services[0]!.volumes.sort()).toEqual([
      '/srv/files',
      '/var/cache/thing',
      '/var/lib/data',
    ]);
    // The bound folder's contents are not on this server; that is said.
    expect(reading.warnings.join(' ')).toContain('./local');
  });

  test('an external volume becomes fresh storage, and says so', () => {
    const reading = services(
      [
        'volumes:',
        '  olddata:',
        '    external: true',
        'services:',
        '  a:',
        '    image: x:1',
        '    volumes:',
        '      - olddata:/data',
      ].join('\n'),
    );
    expect(reading.warnings.join(' ')).toContain('external');
  });
});

describe('what cannot be honoured is said per service', () => {
  test('privileged mode, host networking, devices, entrypoint', () => {
    const reading = services(
      [
        'services:',
        '  spicy:',
        '    image: x:1',
        '    privileged: true',
        '    network_mode: host',
        '    devices:',
        '      - /dev/ttyUSB0',
        '    entrypoint: /custom',
      ].join('\n'),
    );
    const text = reading.warnings.join(' ');
    expect(text).toContain('privileged');
    expect(text).toContain('network mode');
    expect(text).toContain('devices');
    expect(text).toContain('entrypoint');
    // Said, but the service still imports: the map shows it, the warning explains it.
    expect(reading.services.length).toBe(1);
  });

  test('a service behind a profile is left out, like compose leaves it out', () => {
    const reading = services(
      [
        'services:',
        '  debug:',
        '    image: x:1',
        '    profiles: ["tools"]',
        '  web:',
        '    image: y:1',
      ].join('\n'),
    );
    expect(reading.services.map((s) => s.name)).toEqual(['web']);
    expect(reading.warnings.join(' ')).toContain('profile');
  });
});

describe('commands', () => {
  test('the string form is split like a shell would read it', () => {
    expect(shellwords('redis-server --appendonly yes')).toEqual([
      'redis-server',
      '--appendonly',
      'yes',
    ]);
    expect(shellwords('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  test('anything genuinely shell-shaped is handed to a shell', () => {
    expect(shellwords('sh -c "a && b"')).toEqual(['/bin/sh', '-c', 'sh -c "a && b"']);
  });
});

describe('memory limits travel', () => {
  test('compose spellings to megabytes', () => {
    expect(memoryToMb('512m')).toBe(512);
    expect(memoryToMb('1g')).toBe(1024);
    expect(memoryToMb('256M')).toBe(256);
    expect(memoryToMb(536870912)).toBe(512);
    expect(memoryToMb('64k')).toBeNull();
    expect(memoryToMb('nonsense')).toBeNull();
  });

  test('from mem_limit and from deploy.resources', () => {
    const reading = services(
      [
        'services:',
        '  a:',
        '    image: x:1',
        '    mem_limit: 512m',
        '  b:',
        '    image: y:1',
        '    deploy:',
        '      resources:',
        '        limits:',
        '          memory: 1g',
      ].join('\n'),
    );
    expect(reading.services[0]!.memoryLimitMb).toBe(512);
    expect(reading.services[1]!.memoryLimitMb).toBe(1024);
  });
});

describe('depends_on becomes start order', () => {
  test('dependencies come first, however the file is ordered', () => {
    const reading = services(
      [
        'services:',
        '  web:',
        '    image: web:1',
        '    depends_on:',
        '      - db',
        '      - cache',
        '  cache:',
        '    image: redis:7',
        '  db:',
        '    image: postgres:16',
        '    depends_on: [cache]',
      ].join('\n'),
    );
    const ordered = startOrder(reading.services).map((s) => s.name);
    expect(ordered.indexOf('cache')).toBeLessThan(ordered.indexOf('db'));
    expect(ordered.indexOf('db')).toBeLessThan(ordered.indexOf('web'));
  });

  test('the healthy-wait condition is explained, not promised', () => {
    const reading = services(
      [
        'services:',
        '  web:',
        '    image: web:1',
        '    depends_on:',
        '      db:',
        '        condition: service_healthy',
        '  db:',
        '    image: postgres:16',
      ].join('\n'),
    );
    expect(reading.services[0]!.dependsOn).toEqual(['db']);
    expect(reading.warnings.join(' ')).toContain('retry');
  });

  test('a circle is named, not half-imported', () => {
    const reading = services(
      [
        'services:',
        '  a:',
        '    image: x:1',
        '    depends_on: [b]',
        '  b:',
        '    image: y:1',
        '    depends_on: [a]',
      ].join('\n'),
    );
    expect(() => startOrder(reading.services)).toThrow('circle');
  });

  test('a dependency on something not imported is dropped with a note', () => {
    const reading = services(
      ['services:', '  web:', '    image: web:1', '    depends_on: [ghost]'].join('\n'),
    );
    expect(reading.services[0]!.dependsOn).toEqual([]);
    expect(reading.warnings.join(' ')).toContain('ghost');
  });
});

describe('builds', () => {
  test('a build context becomes a repo service rooted in that folder', () => {
    const reading = services(
      [
        'services:',
        '  api:',
        '    build:',
        '      context: ./api',
        '      dockerfile: Dockerfile.prod',
        '  worker:',
        '    build: .',
      ].join('\n'),
    );
    expect(reading.services[0]!.source).toBe('repo');
    expect(reading.services[0]!.rootDir).toBe('api');
    expect(reading.services[0]!.dockerfilePath).toBe('Dockerfile.prod');
    expect(reading.services[1]!.rootDir).toBeNull();
  });

  test('a context that escapes the repository is refused', () => {
    const reading = services(
      ['services:', '  a:', '    build: ../outside', '  b:', '    image: y:1'].join('\n'),
    );
    expect(reading.services.map((s) => s.name)).toEqual(['b']);
    expect(reading.warnings.join(' ')).toContain('outside the repository');
  });
});

describe('applying a plan', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derailed-import-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
  });

  afterEach(async () => {
    // Applying a plan queues real deployments; a job still unwinding when this
    // file finishes would reach for a database the next file has closed.
    const { stopAllDeployments } = await import('../src/build/pipeline.ts');
    await stopAllDeployments();
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('services, variables, storage and aliases all land', async () => {
    const project = createProject('Imported');
    const reading = services(
      [
        'services:',
        '  my_app:',
        '    image: ghost:5',
        '    ports: ["2368:2368"]',
        '    environment:',
        '      database__client: mysql',
        '    volumes:',
        '      - content:/var/lib/ghost/content',
        '    depends_on: [my_db]',
        '    mem_limit: 512m',
        '  my_db:',
        '    image: mysql:8.0',
        '    volumes:',
        '      - db:/var/lib/mysql',
        'volumes:',
        '  content:',
        '  db:',
      ].join('\n'),
    );
    const result = await applyImportPlan(project.id, {
      source: 'compose',
      repoUrl: 'https://github.com/example/stack',
      branch: 'main',
      services: reading.services,
      databases: [],
      jobs: [],
      warnings: reading.warnings,
    });

    expect(result.services.length).toBe(2);
    const all = listServices(project.id);
    const app = all.find((s) => s.name === 'my_app')!;
    const database = all.find((s) => s.name === 'my_db')!;

    // The written name survives as the network alias, underscores and all.
    expect(app.alias).toBe('my_app');
    expect(database.alias).toBe('my_db');
    expect(app.image).toBe('ghost:5');
    expect(app.port).toBe(2368);
    expect(app.memoryLimitMb).toBe(512);

    expect(listEnv(app.id).map((entry) => entry.key)).toContain('database__client');
    expect(listVolumesFor(app.id).map((volume) => volume.containerPath)).toEqual([
      '/var/lib/ghost/content',
    ]);
    expect(listVolumesFor(database.id).map((volume) => volume.containerPath)).toEqual([
      '/var/lib/mysql',
    ]);

    // The database was created before the app that depends on it.
    expect(database.createdAt).toBeLessThanOrEqual(app.createdAt);
    // Both have a deployment queued.
    expect(findService(app.id)).not.toBeNull();
  });

  test('storage over a system folder is refused with a note', async () => {
    const project = createProject('Odd');
    const result = await applyImportPlan(project.id, {
      source: 'compose',
      repoUrl: 'https://github.com/example/odd',
      branch: null,
      databases: [],
      jobs: [],
      services: [
        {
          name: 'a',
          source: 'image',
          image: 'x:1',
          rootDir: null,
          dockerfilePath: null,
          command: null,
          port: null,
          healthCheck: 'started' as const,
          healthPath: null,
          env: [],
          volumes: ['/etc'],
          dependsOn: [],
          memoryLimitMb: null,
        },
      ],
      warnings: [],
    });
    expect(result.warnings.join(' ')).toContain('/etc');
    expect(listVolumesFor(result.services[0]!.id).length).toBe(0);
  });
});
