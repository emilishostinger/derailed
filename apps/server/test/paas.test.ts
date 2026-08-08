import { describe, expect, test } from 'bun:test';
import {
  herokuAddonEngine,
  parseFly,
  parseHeroku,
  parseRailway,
  parseRender,
} from '../src/import/paas.ts';
import { parseToml } from '../src/util/toml.ts';

/**
 * The files the paid platforms leave in a repository, each read into the same
 * plan the compose importer makes. Names travel; secret values never do,
 * because the platforms never wrote them into the repository either.
 */

describe('a Heroku app', () => {
  const APP_JSON = JSON.stringify({
    name: 'my-shop',
    env: {
      SECRET_KEY_BASE: { generator: 'secret' },
      STRIPE_KEY: { required: true },
      LOG_LEVEL: 'info',
    },
    addons: ['heroku-postgresql:essential-0', { plan: 'heroku-redis:mini' }, 'scheduler:standard'],
    formation: { web: { quantity: 2 } },
  });
  const PROCFILE = [
    'web: bundle exec puma -C config/puma.rb',
    'worker: bundle exec sidekiq',
    'release: rake db:migrate',
  ].join('\n');

  test('processes become services; only web is held to answering HTTP', () => {
    const reading = parseHeroku(APP_JSON, PROCFILE);
    expect(reading.services.map((s) => s.name)).toEqual(['web', 'worker']);
    expect(reading.services[0]!.healthCheck).toBe('http');
    expect(reading.services[0]!.command).toEqual([
      'bundle',
      'exec',
      'puma',
      '-C',
      'config/puma.rb',
    ]);
    expect(reading.services[1]!.healthCheck).toBe('started');
  });

  test('the release phase is explained, not silently dropped', () => {
    const reading = parseHeroku(APP_JSON, PROCFILE);
    expect(reading.warnings.join(' ')).toContain('release phase');
  });

  test('env names travel; secret values are generated, unknown ones arrive empty', () => {
    const reading = parseHeroku(APP_JSON, PROCFILE);
    const web = reading.services[0]!;
    const byKey = Object.fromEntries(web.env.map((entry) => [entry.key, entry]));
    expect(byKey.SECRET_KEY_BASE!.generate).toBe(true);
    expect(byKey.STRIPE_KEY!.value).toBe('');
    expect(byKey.LOG_LEVEL!.value).toBe('info');
    expect(reading.warnings.join(' ')).toContain('heroku config');
  });

  test('add-ons become databases of the right engine, linked to every process', () => {
    const reading = parseHeroku(APP_JSON, PROCFILE);
    expect(reading.databases.map((d) => d.engine).sort()).toEqual(['postgres', 'redis']);
    const postgres = reading.databases.find((d) => d.engine === 'postgres')!;
    expect(postgres.linkTo.map((l) => l.service).sort()).toEqual(['web', 'worker']);
    // The one with no equivalent is said, not dropped quietly.
    expect(reading.warnings.join(' ')).toContain('scheduler:standard');
    // And the data has a way over.
    expect(reading.warnings.join(' ')).toContain('pg:backups');
  });

  test('a Procfile alone, or an app.json alone, still imports', () => {
    expect(parseHeroku(null, 'web: npm start').services.length).toBe(1);
    expect(parseHeroku(APP_JSON, null).services[0]!.name).toBe('web');
    expect(() => parseHeroku(null, null)).toThrow('app.json or Procfile');
  });

  test('one instance per app, said when the formation wanted more', () => {
    const reading = parseHeroku(APP_JSON, PROCFILE);
    expect(reading.warnings.join(' ')).toContain('one instance');
  });

  test('the add-on plans people actually have', () => {
    expect(herokuAddonEngine('heroku-postgresql:standard-0')).toBe('postgres');
    expect(herokuAddonEngine('heroku-redis:premium-0')).toBe('redis');
    expect(herokuAddonEngine('jawsdb:kitefin')).toBe('mysql');
    expect(herokuAddonEngine('mongolab:sandbox')).toBe('mongodb');
    expect(herokuAddonEngine('sendgrid:starter')).toBeNull();
  });
});

describe('a Render blueprint', () => {
  const RENDER_YAML = [
    'services:',
    '  - type: web',
    '    name: shop',
    '    runtime: node',
    '    buildCommand: npm install',
    '    startCommand: node server.js',
    '    healthCheckPath: /healthz',
    '    disk:',
    '      name: uploads',
    '      mountPath: /var/uploads',
    '    envVars:',
    '      - key: DATABASE_URL',
    '        fromDatabase:',
    '          name: shop-db',
    '          property: connectionString',
    '      - key: SESSION_SECRET',
    '        generateValue: true',
    '      - key: API_KEY',
    '        sync: false',
    '  - type: worker',
    '    name: mailer',
    '    runtime: node',
    '    startCommand: node worker.js',
    '  - type: cron',
    '    name: nightly',
    '    schedule: "0 3 * * *"',
    '    startCommand: node cleanup.js',
    '  - type: redis',
    '    name: cache',
    'databases:',
    '  - name: shop-db',
    '    postgresMajorVersion: 16',
  ].join('\n');

  test('web answers HTTP on its named path; the worker only has to run', () => {
    const reading = parseRender(RENDER_YAML);
    const web = reading.services.find((s) => s.name === 'shop')!;
    const worker = reading.services.find((s) => s.name === 'mailer')!;
    expect(web.healthCheck).toBe('http');
    expect(web.healthPath).toBe('/healthz');
    expect(web.volumes).toEqual(['/var/uploads']);
    expect(worker.healthCheck).toBe('started');
  });

  test('the database keeps its version and lands under the key that asked for it', () => {
    const reading = parseRender(RENDER_YAML);
    const db = reading.databases.find((d) => d.name === 'shop-db')!;
    expect(db.engine).toBe('postgres');
    expect(db.version).toBe('16');
    expect(db.linkTo).toEqual([{ service: 'shop', injectAs: 'DATABASE_URL' }]);
  });

  test('a redis service is a database here, and the cron is a job in the web app', () => {
    const reading = parseRender(RENDER_YAML);
    expect(reading.databases.find((d) => d.name === 'cache')?.engine).toBe('redis');
    expect(reading.jobs).toEqual([
      { name: 'nightly', command: 'node cleanup.js', schedule: '0 3 * * *', service: 'shop' },
    ]);
  });

  test('generated secrets and dashboard-only values are told apart', () => {
    const reading = parseRender(RENDER_YAML);
    const web = reading.services.find((s) => s.name === 'shop')!;
    const byKey = Object.fromEntries(web.env.map((entry) => [entry.key, entry]));
    expect(byKey.SESSION_SECRET!.generate).toBe(true);
    expect(byKey.API_KEY!.value).toBe('');
    expect(reading.warnings.join(' ')).toContain("Render's dashboard");
  });
});

describe('a Railway service', () => {
  test('the file describes one service; the dashboard keeps the rest, and that is said', () => {
    const reading = parseRailway(
      JSON.stringify({
        build: { builder: 'NIXPACKS' },
        deploy: { startCommand: 'npm run start', healthcheckPath: '/up', numReplicas: 3 },
      }),
    );
    expect(reading.services.length).toBe(1);
    expect(reading.services[0]!.command).toEqual(['npm', 'run', 'start']);
    expect(reading.services[0]!.healthPath).toBe('/up');
    expect(reading.warnings.join(' ')).toContain('dashboard');
    expect(reading.warnings.join(' ')).toContain('one instance');
  });
});

describe('a Fly app', () => {
  const FLY_TOML = [
    'app = "my-shop"',
    'primary_region = "waw"',
    '',
    '[build]',
    '',
    '[env]',
    'PORT = "8080"',
    'LOG_LEVEL = "info"',
    '',
    '[processes]',
    'app = "npm run start"',
    'worker = "npm run worker"',
    '',
    '[http_service]',
    'internal_port = 8080',
    'force_https = true',
    'processes = ["app"]',
    '',
    '[mounts]',
    'source = "data"',
    'destination = "/data"',
    'processes = ["app"]',
    '',
    '[deploy]',
    'release_command = "npm run migrate"',
  ].join('\n');

  test('process groups become services; the web one gets the internal port', () => {
    const reading = parseFly(FLY_TOML);
    const web = reading.services.find((s) => s.name === 'my-shop')!;
    const worker = reading.services.find((s) => s.name === 'my-shop-worker')!;
    expect(web.healthCheck).toBe('http');
    expect(web.port).toBe(8080);
    expect(web.command).toEqual(['npm', 'run', 'start']);
    expect(worker.healthCheck).toBe('started');
  });

  test('mounts follow their process; env is public config and travels', () => {
    const reading = parseFly(FLY_TOML);
    const web = reading.services.find((s) => s.name === 'my-shop')!;
    const worker = reading.services.find((s) => s.name === 'my-shop-worker')!;
    expect(web.volumes).toEqual(['/data']);
    expect(worker.volumes).toEqual([]);
    expect(web.env.find((e) => e.key === 'LOG_LEVEL')?.value).toBe('info');
  });

  test('the release command and the separate database apps are both said', () => {
    const reading = parseFly(FLY_TOML);
    const text = reading.warnings.join(' ');
    expect(text).toContain('release command');
    expect(text).toContain('separate apps');
  });

  test('a one-process file with a build image runs that image', () => {
    const reading = parseFly(
      [
        'app = "tiny"',
        '[build]',
        'image = "ghcr.io/someone/tiny:v3"',
        '[http_service]',
        'internal_port = 3000',
      ].join('\n'),
    );
    expect(reading.services.length).toBe(1);
    expect(reading.services[0]!.source).toBe('image');
    expect(reading.services[0]!.image).toBe('ghcr.io/someone/tiny:v3');
    expect(reading.services[0]!.port).toBe(3000);
  });
});

describe('the TOML slice a fly.toml uses', () => {
  test('tables, arrays of tables, strings, numbers, booleans, arrays', () => {
    const doc = parseToml(
      [
        'app = "x"',
        'count = 3',
        'ratio = 0.5',
        'on = true',
        'list = ["a", "b"]',
        '# a comment',
        '[table]',
        'key = "value" # trailing comment',
        '[[items]]',
        'name = "first"',
        '[[items]]',
        'name = "second"',
        '[table.nested]',
        'deep = 1',
      ].join('\n'),
    );
    expect(doc.app).toBe('x');
    expect(doc.count).toBe(3);
    expect(doc.ratio).toBe(0.5);
    expect(doc.on).toBe(true);
    expect(doc.list).toEqual(['a', 'b']);
    expect((doc.table as { key: string }).key).toBe('value');
    expect((doc.items as { name: string }[]).map((item) => item.name)).toEqual(['first', 'second']);
    expect((doc.table as { nested: { deep: number } }).nested.deep).toBe(1);
  });

  test('a # inside a string is not a comment', () => {
    const doc = parseToml('secret = "abc#def"');
    expect(doc.secret).toBe('abc#def');
  });

  test('inline tables, the shape [mounts] sometimes takes', () => {
    const doc = parseToml('mounts = { source = "data", destination = "/data" }');
    expect(doc.mounts).toEqual({ source: 'data', destination: '/data' });
  });
});
