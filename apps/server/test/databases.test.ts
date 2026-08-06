/**
 * The database catalogue, checked as a whole rather than engine by engine.
 *
 * Adding an engine touches four places that do not import each other: the catalogue
 * itself, the terminal, the backup, and the restore. Nothing made you visit all four,
 * and the failure from missing one is quiet: a database that runs perfectly and then
 * turns out, months later, not to be in any of the backups. So these walk the
 * catalogue and insist that every engine in it is handled everywhere it needs to be.
 */
import { describe, expect, test } from 'bun:test';
import { dumpCommandFor, restoreCommandFor } from '../src/backup/backup.ts';
import {
  commandFor,
  DATABASE_ENGINES,
  type DatabaseCredentials,
  findEngine,
} from '../src/catalog/databases.ts';
import { shellCommandFor } from '../src/docker/exec.ts';

const CREDENTIALS: DatabaseCredentials = {
  host: 'd_project_db',
  dbName: 'blog',
  user: 'derailed',
  password: 'sV9pQx2LmNb4',
};

describe('every engine in the catalogue', () => {
  test.each(DATABASE_ENGINES.map((engine) => [engine.label, engine] as const))(
    '%s is completely described',
    (_label, engine) => {
      expect(engine.versions.length).toBeGreaterThan(0);
      expect(engine.port).toBeGreaterThan(0);
      expect(engine.volumePath.startsWith('/')).toBe(true);
      expect(engine.blurb.length).toBeGreaterThan(10);
      expect(findEngine(engine.engine)).toBe(engine);

      // Every listed version has to produce an image reference, and the default is
      // the first one.
      for (const version of engine.versions) {
        expect(engine.image(version)).toContain(version);
      }

      const url = engine.urlTemplate(CREDENTIALS);
      expect(url).toContain(CREDENTIALS.host);
      // Never the raw password: it goes through `encodeURIComponent`, and a URL that
      // breaks on a punctuation character is a support ticket a year from now.
      expect(url).toContain(encodeURIComponent(CREDENTIALS.password));
    },
  );

  test.each(DATABASE_ENGINES.map((engine) => [engine.label, engine] as const))(
    '%s can be opened in the terminal',
    (_label, engine) => {
      const { cmd, env } = shellCommandFor(engine.engine, CREDENTIALS);
      // Not the fallback shell: the point of the terminal on a database is to land
      // in the client, and an engine nobody wired up silently lands in `sh`.
      expect(cmd[0]).not.toBe('/bin/sh');
      expect(cmd).not.toContain('-c');

      // The password reaches the client somehow, and never by being pasted into a
      // longer string. It is either an environment entry or an argument of its own,
      // so there is nothing a punctuation character in it could break out of.
      const inEnv = env.some((entry) => entry.endsWith(`=${CREDENTIALS.password}`));
      const asOwnArgument = cmd.includes(CREDENTIALS.password);
      expect(inEnv || asOwnArgument).toBe(true);
      expect(
        cmd.some((part) => part !== CREDENTIALS.password && part.includes(CREDENTIALS.password)),
      ).toBe(false);

      // Env is the default. MongoDB is the exception, and only because its client
      // reads a password from nowhere but an argument or an interactive prompt.
      if (!inEnv) expect(engine.engine).toBe('mongodb');
    },
  );

  test.each(DATABASE_ENGINES.map((engine) => [engine.label, engine] as const))(
    '%s can be backed up',
    (_label, engine) => {
      const dump = dumpCommandFor(engine.engine, CREDENTIALS);
      expect(dump).not.toBeNull();
      expect(dump!.file).toMatch(/^dump\./);
      // An argument list, never a line of shell: nothing here can be escaped wrongly
      // because nothing here is parsed by a shell at all.
      expect(dump!.cmd[0]).not.toBe('sh');
      expect(dump!.cmd).not.toContain('-c');
      if (dump!.prepare) expect(dump!.prepare[0]).not.toBe('sh');

      // Nothing writes its dump to a pipe. `redis-cli --rdb /dev/stdout` reads as
      // though it would work and does not: the tool fsyncs and truncates what it
      // wrote, so it failed, and it took every backup of every project holding a
      // Redis down with it without ever saying why.
      expect(dump!.cmd).not.toContain('/dev/stdout');
      expect(dump!.prepare ?? []).not.toContain('/dev/stdout');
    },
  );

  test('a dump that cannot go to stdout fetches its file in a second step', () => {
    for (const engine of ['redis', 'valkey']) {
      const dump = dumpCommandFor(engine, CREDENTIALS)!;
      expect(dump.prepare).toBeDefined();
      // The write and the read name the same file, or the backup is of nothing.
      const written = dump.prepare![dump.prepare!.length - 1]!;
      expect(dump.cmd).toContain(written);
    }
  });

  test('the ones that can be restored say so, and the ones that cannot are honest', () => {
    for (const engine of DATABASE_ENGINES) {
      const restore = restoreCommandFor(engine.engine, CREDENTIALS);
      if (restore) {
        expect(restore.cmd[0]).not.toBe('sh');
        expect(restore.cmd).not.toContain('-c');
      } else {
        // Only the key-value stores, whose backup is a binary snapshot that cannot be
        // piped back in. The UI says as much rather than failing halfway.
        expect(['redis', 'valkey']).toContain(engine.engine);
      }
    }
  });

  test('the ones needing a password on the command line get one', () => {
    for (const engine of DATABASE_ENGINES) {
      const command = commandFor(engine, CREDENTIALS);
      if (command) expect(command).toContain(CREDENTIALS.password);
    }
    // Both key-value stores need it, because neither reads the password from the
    // environment at startup.
    expect(commandFor(findEngine('redis')!, CREDENTIALS)).toBeTruthy();
    expect(commandFor(findEngine('valkey')!, CREDENTIALS)).toBeTruthy();
  });
});

describe('what the catalogue offers', () => {
  test('has no duplicate engine names', () => {
    const names = DATABASE_ENGINES.map((engine) => engine.engine);
    expect(new Set(names).size).toBe(names.length);
  });

  test('covers the engines people actually ask for', () => {
    const names = DATABASE_ENGINES.map((engine) => engine.engine);
    expect(names).toEqual(
      expect.arrayContaining(['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']),
    );
  });

  test('Valkey is offered as a Redis client would find it', () => {
    const valkey = findEngine('valkey')!;
    // It speaks the Redis protocol, so the variable an app reads and the scheme in
    // the URL are the Redis ones. Injecting VALKEY_URL would mean every library in
    // the world needing to be told about it.
    expect(valkey.defaultInjectKey).toBe('REDIS_URL');
    expect(valkey.urlTemplate(CREDENTIALS).startsWith('redis://')).toBe(true);
  });

  test('MongoDB connects against the database its user actually lives in', () => {
    // The root user is created in `admin`, not in the named database, so without
    // this every driver connects and is then refused.
    expect(findEngine('mongodb')!.urlTemplate(CREDENTIALS)).toContain('authSource=admin');
  });
});
