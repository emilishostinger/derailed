import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectServices } from '../src/catalog/links.ts';
import { ShareError, shareTemplate } from '../src/catalog/share.ts';
import { parseTemplate } from '../src/catalog/templates.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { replaceUserEnv, setEnv } from '../src/db/repo/env.ts';
import { linksFrom } from '../src/db/repo/links.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { containerName, createAppService, createDatabaseService } from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Turning an app into a template somebody else can run.
 *
 * Almost all of this is one question: does a secret get out. The person pressing the
 * button is by definition about to publish the file, and the file is generated from
 * the app's own variables, which is exactly where its database password, session key
 * and API tokens are. Every test here is a way that could go wrong.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-share-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function anApp(overrides: Partial<Parameters<typeof createAppService>[0]> = {}) {
  const project = createProject('Shop');
  return createAppService({
    projectId: project.id,
    name: 'Ghost',
    source: 'image',
    image: 'ghost:5-alpine',
    port: 2368,
    repoUrl: null,
    branch: null,
    ...overrides,
  });
}

describe('what a shared template carries', () => {
  test('the things somebody else needs to run it', () => {
    const app = anApp();
    createVolume(app.id, '/var/lib/ghost/content');
    replaceUserEnv(app.id, [{ key: 'NODE_ENV', value: 'production' }]);

    const shared = shareTemplate(app.id);
    expect(shared.name).toBe('Ghost');
    expect(shared.image).toBe('ghost:5-alpine');
    expect(shared.port).toBe(2368);
    expect(shared.volumes).toEqual(['/var/lib/ghost/content']);
    expect(shared.env).toEqual({ NODE_ENV: 'production' });
  });

  test('and reads back as a template, which is the only thing it is for', () => {
    const app = anApp();
    createVolume(app.id, '/var/lib/ghost/content');
    replaceUserEnv(app.id, [{ key: 'NODE_ENV', value: 'production' }]);

    // Round trip through the same validator a pasted link goes through.
    const parsed = parseTemplate(JSON.parse(JSON.stringify(shareTemplate(app.id))));
    expect(parsed.image).toBe('ghost:5-alpine');
    expect(parsed.port).toBe(2368);
    expect(parsed.volumes).toEqual(['/var/lib/ghost/content']);
    expect(parsed.env).toEqual({ NODE_ENV: 'production' });
  });
});

describe('what a shared template must never carry', () => {
  test('a variable whose name says it is a secret', () => {
    const app = anApp();
    replaceUserEnv(app.id, [
      { key: 'ADMIN_PASSWORD', value: 'hunter2' },
      { key: 'STRIPE_API_KEY', value: 'sk_live_abc' },
      { key: 'SESSION_SECRET', value: 'shhh' },
      { key: 'JWT_SIGNING_KEY', value: 'abc' },
      { key: 'AWS_ACCESS_KEY_ID', value: 'AKIA' },
      { key: 'NODE_ENV', value: 'production' },
    ]);

    const shared = shareTemplate(app.id);
    const written = JSON.stringify(shared);

    for (const secret of ['hunter2', 'sk_live_abc', 'shhh', 'abc', 'AKIA']) {
      expect(written).not.toContain(secret);
    }
    // Named, so the installing server generates its own rather than leaving it unset.
    expect(shared.generatedEnv).toContain('ADMIN_PASSWORD');
    expect(shared.generatedEnv).toContain('STRIPE_API_KEY');
    expect(shared.generatedEnv).toContain('SESSION_SECRET');
    expect(shared.env).toEqual({ NODE_ENV: 'production' });
  });

  test('a value that looks generated even when the name is innocent', () => {
    // The name is the first line of defence and not the only one. Nobody calls it
    // `THING_SECRET` when they paste a key into a field called `LICENCE`.
    const app = anApp();
    replaceUserEnv(app.id, [
      { key: 'LICENCE', value: 'a8Kd93MnZq0PlXcV7bNm4RtY2wEs' },
      { key: 'GREETING', value: 'hello there' },
      { key: 'PORT', value: '2368' },
    ]);

    const shared = shareTemplate(app.id);
    expect(JSON.stringify(shared)).not.toContain('a8Kd93MnZq0PlXcV7bNm4RtY2wEs');
    expect(shared.generatedEnv).toEqual(['LICENCE']);
    expect(shared.env).toEqual({ GREETING: 'hello there', PORT: '2368' });
  });

  test('a database password in an app that was never linked to the database', () => {
    // Found by exporting a real Umami. Installing a template sets the app's variables
    // from the database and then records a link inside a `try` that swallows failures,
    // so the link was missing while `DATABASE_URL` held the live password. Looking
    // only at the link meant no substitution happened, and `DATABASE_URL` is not a
    // secret-sounding name, so nothing else caught it and the password went in the
    // file. The lesson is that the link is bookkeeping and the value is the truth.
    const project = createProject('Analytics');
    const app = createAppService({
      projectId: project.id,
      name: 'umami',
      source: 'image',
      image: 'ghcr.io/umami-software/umami:postgresql-latest',
      port: 3000,
      repoUrl: null,
      branch: null,
    });
    const database = createDatabaseService({
      projectId: project.id,
      name: 'umami-db',
      engine: 'postgres',
      version: '17',
      dbName: 'umami_db',
      dbUser: 'derailed',
      dbPassword: 'not-the-real-password-0123456789',
      port: 5432,
    });
    // Deliberately no `connectServices`: that is the whole point.
    expect(linksFrom(app.id)).toHaveLength(0);

    replaceUserEnv(app.id, [
      { key: 'DATABASE_TYPE', value: 'postgresql' },
      {
        key: 'DATABASE_URL',
        value: `postgres://derailed:not-the-real-password-0123456789@${containerName(project.slug, database.slug)}:5432/umami_db`,
      },
    ]);

    const shared = shareTemplate(app.id);
    const written = JSON.stringify(shared);
    expect(written).not.toContain('not-the-real-password-0123456789');
    expect(shared.database?.env.DATABASE_URL).toBe('{url}');
    expect(shared.env).toEqual({ DATABASE_TYPE: 'postgresql' });
  });

  test('a password that appears in the middle of some unrelated prose', () => {
    // Substitution is by value and not by variable name, so it does not matter what
    // the variable is called or what else is in it. This is also why the final sweep
    // in `shareTemplate` cannot fire today: it checks the same passwords this already
    // replaced. It is kept as a guard on the rules above, not as a live path.
    const project = createProject('Shop');
    const app = createAppService({
      projectId: project.id,
      name: 'Thing',
      source: 'image',
      image: 'thing:1',
      port: 80,
      repoUrl: null,
      branch: null,
    });
    createDatabaseService({
      projectId: project.id,
      name: 'db',
      engine: 'postgres',
      version: '17',
      dbName: 'shop',
      dbUser: 'derailed',
      dbPassword: 'correct horse battery staple',
      port: 5432,
    });

    replaceUserEnv(app.id, [
      { key: 'NOTES', value: 'the db password is correct horse battery staple, do not lose it' },
    ]);

    const shared = shareTemplate(app.id);
    expect(JSON.stringify(shared)).not.toContain('correct horse battery staple');
    expect(shared.database?.env.NOTES).toBe('the db password is {password}, do not lose it');
  });

  test('does not mangle a value that merely contains a database name', () => {
    // Real, in the first template exported from a real server: the database was
    // called `postgres` and the user `derailed`, so `DATABASE_TYPE=postgresql` came
    // out as `{dbName}ql` and a salt that happened to read `derailed` came out as
    // `{user}`. Short ordinary words are matched whole or not at all.
    const project = createProject('Analytics');
    const app = createAppService({
      projectId: project.id,
      name: 'umami',
      source: 'image',
      image: 'umami:1',
      port: 3000,
      repoUrl: null,
      branch: null,
    });
    const database = createDatabaseService({
      projectId: project.id,
      name: 'postgres',
      engine: 'postgres',
      version: '17',
      dbName: 'postgres',
      dbUser: 'derailed',
      dbPassword: 'a-long-enough-password',
      port: 5432,
    });
    connectServices(app.id, database.id);

    replaceUserEnv(app.id, [
      { key: 'DATABASE_TYPE', value: 'postgresql' },
      { key: 'HASH_SALT', value: 'derailed' },
      { key: 'DB_NAME', value: 'postgres' },
    ]);

    const shared = shareTemplate(app.id);
    expect(shared.env?.DATABASE_TYPE).toBe('postgresql');
    // Whole-value matches are still replaced, which is the point of doing it at all.
    expect(shared.database?.env.DB_NAME).toBe('{dbName}');
    // A salt is a secret by name whatever its value happens to look like.
    expect(shared.generatedEnv).toContain('HASH_SALT');
  });

  test('picks the database whose secret is in the value, not the first one that rhymes', () => {
    // Two databases on one server share a user name and a port. Matching on those
    // picked the wrong one, substituted the wrong password, and left the right one
    // sitting in the file looking handled.
    const project = createProject('Shop');
    const app = createAppService({
      projectId: project.id,
      name: 'app',
      source: 'image',
      image: 'app:1',
      port: 3000,
      repoUrl: null,
      branch: null,
    });
    const other = createDatabaseService({
      projectId: project.id,
      name: 'other-db',
      engine: 'postgres',
      version: '17',
      dbName: 'other',
      dbUser: 'derailed',
      dbPassword: 'the-other-databases-password',
      port: 5432,
    });
    const mine = createDatabaseService({
      projectId: project.id,
      name: 'my-db',
      engine: 'postgres',
      version: '17',
      dbName: 'mine',
      dbUser: 'derailed',
      dbPassword: 'the-password-that-must-not-escape',
      port: 5432,
    });
    // Linked to the *other* one, so the link points the wrong way on purpose.
    connectServices(app.id, other.id);

    replaceUserEnv(app.id, [
      {
        key: 'DATABASE_URL',
        value: `postgres://derailed:the-password-that-must-not-escape@${containerName(project.slug, mine.slug)}:5432/mine`,
      },
    ]);

    const shared = shareTemplate(app.id);
    const written = JSON.stringify(shared);
    expect(written).not.toContain('the-password-that-must-not-escape');
    expect(written).not.toContain('the-other-databases-password');
    expect(shared.database?.env.DATABASE_URL).toBe('{url}');
    // And the template describes the database the value actually came from.
    expect(shared.database?.version).toBe('17');
  });

  test('anything Derailed injected, which belongs to this server', () => {
    // A connection string pointing at our container, carried to somebody else's
    // machine, is either broken or an invitation. Either way it is not theirs.
    const app = anApp();
    setEnv(app.id, 'DATABASE_URL', 'postgres://u:p@d_shop_db:5432/shop', 'link');
    setEnv(app.id, 'NODE_ENV', 'production', 'user');

    const shared = shareTemplate(app.id);
    expect(JSON.stringify(shared)).not.toContain('d_shop_db');
    expect(shared.env).toEqual({ NODE_ENV: 'production' });
  });
});

describe('an app with a database', () => {
  function appWithDatabase() {
    const project = createProject('Shop');
    const app = createAppService({
      projectId: project.id,
      name: 'Ghost',
      source: 'image',
      image: 'ghost:5-alpine',
      port: 2368,
      repoUrl: null,
      branch: null,
    });
    const database = createDatabaseService({
      projectId: project.id,
      name: 'ghost-db',
      engine: 'mysql',
      version: '8.0',
      dbName: 'ghost',
      dbUser: 'derailed',
      dbPassword: 'a-real-password-nobody-should-see',
      port: 3306,
    });
    connectServices(app.id, database.id);
    return { app, database };
  }

  test('describes the database rather than carrying its password', () => {
    const { app, database } = appWithDatabase();
    const { credentialsFor } =
      require('../src/catalog/create.ts') as typeof import('../src/catalog/create.ts');
    const credentials = credentialsFor(database)!;

    replaceUserEnv(app.id, [
      { key: 'database__connection__host', value: credentials.host },
      { key: 'database__connection__user', value: credentials.user },
      { key: 'database__connection__password', value: credentials.password },
      { key: 'database__connection__database', value: credentials.dbName },
      { key: 'NODE_ENV', value: 'production' },
    ]);

    const shared = shareTemplate(app.id);
    const written = JSON.stringify(shared);

    expect(written).not.toContain(credentials.password);
    expect(written).not.toContain(credentials.host);
    expect(shared.database?.engine).toBe('mysql');
    expect(shared.database?.version).toBe('8.0');
    expect(shared.database?.env).toEqual({
      database__connection__host: '{host}',
      database__connection__user: '{user}',
      database__connection__password: '{password}',
      database__connection__database: '{dbName}',
    });
    expect(shared.env).toEqual({ NODE_ENV: 'production' });
  });

  test('replaces the password inside a longer string too', () => {
    // A connection URL contains the password in the middle of it. Matching the URL
    // first, because it is longer, keeps it as one placeholder rather than a URL with
    // a hole punched in it.
    const { app, database } = appWithDatabase();
    const { connectionUrl, credentialsFor } =
      require('../src/catalog/create.ts') as typeof import('../src/catalog/create.ts');
    const credentials = credentialsFor(database)!;

    replaceUserEnv(app.id, [{ key: 'DB_URL', value: connectionUrl(database)! }]);

    const shared = shareTemplate(app.id);
    expect(JSON.stringify(shared)).not.toContain(credentials.password);
    expect(shared.database?.env.DB_URL).toBe('{url}');
  });

  test('the placeholders are filled back in on the way in', () => {
    const { app, database } = appWithDatabase();
    const { credentialsFor } =
      require('../src/catalog/create.ts') as typeof import('../src/catalog/create.ts');
    const credentials = credentialsFor(database)!;
    replaceUserEnv(app.id, [
      { key: 'DB_HOST', value: credentials.host },
      { key: 'DB_PASS', value: credentials.password },
    ]);

    const parsed = parseTemplate(JSON.parse(JSON.stringify(shareTemplate(app.id))));
    const filled = parsed.database!.env({
      host: 'their-db',
      port: 3306,
      dbName: 'theirs',
      user: 'them',
      password: 'their-secret',
      url: 'mysql://them:their-secret@their-db:3306/theirs',
    });

    expect(filled).toEqual({ DB_HOST: 'their-db', DB_PASS: 'their-secret' });
  });

  test('a placeholder it was not offered is left alone', () => {
    // `{password}` is a thing a template may ask for. `{env}` is not, and a template
    // that could invent placeholders is a template that can go looking.
    const parsed = parseTemplate({
      name: 'Thing',
      image: 'thing:1',
      port: 80,
      database: {
        engine: 'mysql',
        version: '8.0',
        env: { A: '{password}', B: '{secretEnv}', C: '{{host}}' },
      },
    });

    const filled = parsed.database!.env({
      host: 'h',
      port: 3306,
      dbName: 'd',
      user: 'u',
      password: 'p',
      url: 'url',
    });
    expect(filled).toEqual({ A: 'p', B: '{secretEnv}', C: '{h}' });
  });

  test('refuses a database engine or version the catalogue does not offer', () => {
    for (const database of [
      { engine: 'oracle', version: '19' },
      { engine: 'mysql', version: '4.0' },
      { engine: 'mysql' },
      { engine: 'postgres', version: 'latest' },
    ]) {
      const parsed = parseTemplate({ name: 'Thing', image: 'thing:1', port: 80, database });
      expect(parsed.database).toBeUndefined();
    }
  });
});

describe('what cannot be shared, and says so', () => {
  test('an app built from a repository', () => {
    const app = anApp({ source: 'repo', image: null, repoUrl: 'https://github.com/a/b' });
    expect(() => shareTemplate(app.id)).toThrow(ShareError);
    expect(() => shareTemplate(app.id)).toThrow(/built from source/);
  });

  test('an app whose port nobody has set', () => {
    const app = anApp({ port: null });
    expect(() => shareTemplate(app.id)).toThrow(/which port/);
  });

  test('a database', () => {
    const project = createProject('Shop');
    const database = createDatabaseService({
      projectId: project.id,
      name: 'db',
      engine: 'mysql',
      version: '8.0',
      dbName: 'shop',
      dbUser: 'derailed',
      dbPassword: 'secret',
      port: 3306,
    });
    expect(() => shareTemplate(database.id)).toThrow(/Only apps/);
  });
});
