import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, stopAllDeployments } from '../src/build/pipeline.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { listServices } from '../src/db/repo/services.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { projectNetworkName, removeNetwork } from '../src/docker/networks.ts';
import { listVolumes, removeVolume } from '../src/docker/volumes.ts';
import { applyImportPlan } from '../src/import/apply.ts';
import { parseHeroku } from '../src/import/paas.ts';
import { listJobs } from '../src/jobs/run.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * A Heroku app arriving for real: the plan from app.json + Procfile applied
 * against Docker. The database is a real Postgres with its address wired into
 * the app, the generated secret is generated, and the names the person will
 * paste values under are already on the Variables tab.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping platform import integration tests');
}

let dir = '';
let projectId = '';

suite('a Heroku app becomes a working project', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-paas-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    projectId = createProject('Arrived').id;
  }, 120_000);

  afterAll(async () => {
    await stopAllDeployments();
    expect(activeJobCount()).toBe(0);
    const containers = await listContainers(labelFilter({ [LABELS.project]: projectId })).catch(
      () => [],
    );
    for (const container of containers)
      await destroyContainer(container.Id, 1).catch(() => undefined);
    const volumes = await listVolumes().catch(() => []);
    for (const volume of volumes) {
      if (volume.Labels?.[LABELS.project] === projectId) {
        await removeVolume(volume.Name).catch(() => undefined);
      }
    }
    await removeNetwork(projectNetworkName(projectId)).catch(() => undefined);
    closeDb();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  test('services, a real database, the wiring and the secrets all land', async () => {
    const reading = parseHeroku(
      JSON.stringify({
        env: {
          SECRET_KEY_BASE: { generator: 'secret' },
          STRIPE_KEY: { required: true },
        },
        addons: ['heroku-postgresql:essential-0'],
      }),
      'web: npm start\nworker: npm run jobs',
    );

    const result = await applyImportPlan(projectId, {
      source: 'heroku',
      repoUrl: 'https://github.com/example/arrival',
      branch: 'main',
      services: reading.services,
      databases: reading.databases,
      jobs: [
        // What a Render blueprint would have carried; proves the job path too.
        { name: 'tidy up', command: 'npm run cleanup', schedule: '0 3 * * *', service: 'web' },
      ],
      warnings: reading.warnings,
    });

    expect(result.services.map((service) => service.name).sort()).toEqual(['web', 'worker']);
    expect(result.databases.length).toBe(1);

    // The database is a real running Postgres.
    const database = result.databases[0]!;
    expect(database.kind).toBe('database');
    expect(database.dbEngine).toBe('postgres');
    const containers = await listContainers(labelFilter({ [LABELS.service]: database.id }));
    expect(containers[0]?.State).toBe('running');

    // The wiring: both processes hold the database's address under DATABASE_URL,
    // injected by the link rather than pasted by anyone.
    const services = listServices(projectId);
    for (const name of ['web', 'worker']) {
      const app = services.find((service) => service.name === name)!;
      const env = listEnv(app.id);
      const url = env.find((entry) => entry.key === 'DATABASE_URL');
      expect(url?.source).toBe('link');
      expect(url?.value).toContain('postgres://');

      // The generated secret was generated; the unknown one is a named blank.
      const secret = env.find((entry) => entry.key === 'SECRET_KEY_BASE');
      expect(secret?.value.length).toBeGreaterThan(12);
      expect(env.find((entry) => entry.key === 'STRIPE_KEY')?.value).toBe('');
    }

    // The schedule became an ordinary job on the web app.
    const web = services.find((service) => service.name === 'web')!;
    const jobs = listJobs(web.id);
    expect(jobs.map((job) => job.name)).toContain('tidy up');
  }, 600_000);
});
