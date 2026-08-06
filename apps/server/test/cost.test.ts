import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import {
  createAppService,
  createDatabaseService,
  softDeleteService,
} from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { costComparison } from '../src/system/cost.ts';

/**
 * What this would cost elsewhere.
 *
 * The figure is a party trick, but an honest one is the only kind worth having: the
 * first person who checks it and finds it flattering stops believing everything else
 * on the screen. So these tests are mostly about it not overstating itself.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function app(projectId: string, name: string) {
  return createAppService({
    projectId,
    name,
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
}

function database(projectId: string, name: string) {
  return createDatabaseService({
    projectId,
    name,
    engine: 'postgres',
    version: '16',
    dbName: 'app',
    dbUser: 'app',
    dbPassword: 'secret',
    port: 5432,
  });
}

describe('an empty server', () => {
  test('says nothing worth screenshotting', () => {
    const cost = costComparison();
    expect(cost.apps).toBe(0);
    expect(cost.databases).toBe(0);
    // An enthusiastic "$0 saved!" on an empty server reads as a product trying too
    // hard, so the summary points at deploying something instead.
    expect(cost.summary).toContain('Nothing running yet');
  });
});

describe('counting what is running', () => {
  test('counts apps, databases and stored folders', () => {
    const project = createProject('Shop');
    const web = app(project.id, 'Web');
    app(project.id, 'Worker');
    database(project.id, 'Postgres');
    createVolume(web.id, '/data');

    const cost = costComparison();
    expect(cost.apps).toBe(2);
    expect(cost.databases).toBe(1);
    expect(cost.storageGb).toBe(1);
    expect(cost.projects).toBe(1);
  });

  test('leaves out anything in the trash', () => {
    const project = createProject('Shop');
    app(project.id, 'Web');
    const doomed = app(project.id, 'Old');

    softDeleteService(doomed.id);

    // Billing for something that is not running would be exactly the kind of
    // overstatement that makes the whole figure worthless.
    expect(costComparison().apps).toBe(1);
  });
});

describe('the figures themselves', () => {
  test('prices every provider, cheapest first', () => {
    const project = createProject('Shop');
    app(project.id, 'Web');
    database(project.id, 'Postgres');

    const cost = costComparison();
    expect(cost.elsewhere.length).toBeGreaterThan(3);

    const monthly = cost.elsewhere.map((entry) => entry.monthly);
    expect([...monthly].sort((a, b) => a - b)).toEqual(monthly);
    expect(cost.cheapestMonthly).toBe(monthly[0] ?? 0);
    expect(cost.dearestMonthly).toBe(monthly[monthly.length - 1] ?? 0);
  });

  test('costs more as more is run', () => {
    const project = createProject('Shop');
    app(project.id, 'One');
    const before = costComparison().cheapestMonthly;

    app(project.id, 'Two');
    database(project.id, 'Postgres');
    expect(costComparison().cheapestMonthly).toBeGreaterThan(before);
  });

  test('says when the prices were checked, so an old figure looks old', () => {
    expect(costComparison().pricesCheckedAt).toMatch(/^\d{4}-\d{2}$/);
  });

  test('names what is being priced in the summary', () => {
    const project = createProject('Shop');
    app(project.id, 'Web');
    database(project.id, 'Postgres');

    const summary = costComparison().summary;
    expect(summary).toContain('1 app');
    expect(summary).toContain('1 database');
    expect(summary).toMatch(/\$\d+/);
  });
});
