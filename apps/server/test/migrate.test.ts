import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeInstall, importInstall } from '../src/backup/migrate.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createDomain } from '../src/db/repo/domains.ts';
import { listEnv, replaceUserEnv } from '../src/db/repo/env.ts';
import { createProject, listProjects } from '../src/db/repo/projects.ts';
import { createAppService, createDatabaseService, listServices } from '../src/db/repo/services.ts';
import { createVolume, listVolumesFor } from '../src/db/repo/volumes.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Moving everything to another machine.
 *
 * The point of this feature is being able to answer "what if this project dies", so
 * the tests are mostly about the file being complete and honest: everything that has
 * to come across does, and the one thing that must not travel does not.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-move-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function buildAnInstall() {
  const project = createProject('Shop');
  const app = createAppService({
    projectId: project.id,
    name: 'Storefront',
    source: 'repo',
    repoUrl: 'https://github.com/someone/shop',
    branch: 'main',
    port: 3000,
  });
  createDatabaseService({
    projectId: project.id,
    name: 'Postgres',
    engine: 'postgres',
    version: '16',
    dbName: 'shop',
    dbUser: 'shop',
    dbPassword: 'the-old-password',
    port: 5432,
  });
  createVolume(app.id, '/data');
  createDomain(app.id, 'shop.example.com', 'custom');
  replaceUserEnv(app.id, [
    { key: 'STRIPE_KEY', value: 'sk_live_dont_leak_me' },
    { key: 'NODE_ENV', value: 'production' },
  ]);
  return { project, app };
}

describe('what leaves the machine', () => {
  test('describes the shape of everything', () => {
    buildAnInstall();
    const plan = describeInstall();

    expect(plan.projects).toHaveLength(1);
    const project = plan.projects[0]!;
    expect(project.services).toHaveLength(2);

    const app = project.services.find((service) => service.kind === 'app');
    expect(app?.repoUrl).toBe('https://github.com/someone/shop');
    expect(app?.volumes).toEqual(['/data']);
    expect(app?.domains[0]?.hostname).toBe('shop.example.com');
  });

  test('carries variable names and never their values', () => {
    // The whole reason variables are encrypted is that they are secrets. Putting the
    // values into a file somebody emails themselves would undo that entirely.
    buildAnInstall();
    const plan = describeInstall();
    const serialised = JSON.stringify(plan);

    expect(serialised).toContain('STRIPE_KEY');
    expect(serialised).not.toContain('sk_live_dont_leak_me');
    expect(serialised).not.toContain('the-old-password');
  });

  test('says what still has to be done by hand', () => {
    buildAnInstall();
    const plan = describeInstall();
    // A migration that ends silently leaves somebody wondering why nothing works.
    expect(plan.afterwards.join(' ')).toContain('A record');
    expect(plan.afterwards.join(' ')).toContain('variables');
    expect(plan.afterwards.join(' ')).toContain('private repositories');
  });
});

describe('what arrives on the other side', () => {
  test('recreates the projects, apps, storage and domains', () => {
    buildAnInstall();
    const plan = describeInstall();

    // A brand new machine.
    closeDb();
    initDb(':memory:');

    const result = importInstall(plan);
    expect(result.projects).toBe(1);
    expect(result.services).toBe(2);
    expect(result.domains).toBe(1);

    const project = listProjects()[0]!;
    const services = listServices(project.id);
    expect(services).toHaveLength(2);

    const app = services.find((service) => service.kind === 'app')!;
    expect(app.repoUrl).toBe('https://github.com/someone/shop');
    expect(listVolumesFor(app.id).map((volume) => volume.containerPath)).toEqual(['/data']);
  });

  test('leaves the variables named and empty, so it is obvious what to fill in', () => {
    buildAnInstall();
    const plan = describeInstall();
    closeDb();
    initDb(':memory:');
    importInstall(plan);

    const app = listServices().find((service) => service.kind === 'app')!;
    const env = listEnv(app.id);
    expect(env.map((entry) => entry.key).sort()).toEqual(['NODE_ENV', 'STRIPE_KEY']);
    for (const entry of env) expect(entry.value).toBe('');
  });

  test('starts nothing', () => {
    // Importing a plan must never be the moment a new machine begins pulling images
    // and taking traffic. Everything arrives stopped, with no deploys queued.
    buildAnInstall();
    const plan = describeInstall();
    closeDb();
    initDb(':memory:');
    importInstall(plan);

    const { listDeployments } = require('../src/db/repo/deployments.ts');
    for (const service of listServices()) {
      expect(listDeployments(service.id)).toHaveLength(0);
    }
  });

  test('does not quietly change a machine that is already busy', () => {
    buildAnInstall();
    const plan = describeInstall();

    closeDb();
    initDb(':memory:');
    createProject('Shop');

    const result = importInstall(plan);
    expect(result.projects).toBe(0);
    expect(result.warnings.join(' ')).toContain('already here');
  });

  test('refuses a file from a version it does not understand', () => {
    expect(() => importInstall({ ...describeInstall(), version: 99 as 1 })).toThrow(
      /does not understand/,
    );
  });
});
