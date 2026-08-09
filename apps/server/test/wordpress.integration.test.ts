import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeJobCount, stopAllDeployments } from '../src/build/pipeline.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { latestDeployment } from '../src/db/repo/deployments.ts';
import { listProjects } from '../src/db/repo/projects.ts';
import { findService, listServices } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { ping } from '../src/docker/client.ts';
import { destroyContainer, listContainers } from '../src/docker/containers.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { removeNetwork } from '../src/docker/networks.ts';
import { createApp } from '../src/http/app.ts';
import {
  adminLoginUrl,
  createStaging,
  listWpUpdates,
  pushStagingLive,
  runWp,
  stagingOf,
} from '../src/system/wordpress.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * WordPress superpowers, walked whole against real containers: the template
 * installs, WP-CLI runs inside the site's world, a sign-in link is minted, the
 * update list answers, a staging copy comes up with its own database and files
 * and rewritten links, and push-to-live carries a change made on staging back to
 * production with a backup taken first.
 *
 * Slow and worth it: every piece here (VolumesFrom, env borrowing, snapshot
 * restore into a clone, volume copy, search-replace both ways) only fails in
 * ways a unit test cannot see.
 */

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn('[test] Docker socket not reachable, skipping WordPress integration tests');
}

let dir = '';
let projectId = '';
let wpId = '';
let cookie = '';
let app: ReturnType<typeof createApp>;

async function settled(serviceId: string, timeoutMs = 600_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = latestDeployment(serviceId);
    if (deployment?.finishedAt) return deployment.status;
    await Bun.sleep(1000);
  }
  return 'timeout';
}

suite('wordpress superpowers against real containers', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'derailed-wp-int-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
    setSetting(SETTINGS.serverIp, '203.0.113.7');
    app = createApp();

    const setup = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
    });
    cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const madeProject = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'WP walk' }),
    });
    projectId = ((await madeProject.json()) as { project: { id: string } }).project.id;

    const installed = await app.request(`/api/projects/${projectId}/templates`, {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ slug: 'wordpress' }),
    });
    expect(installed.status).toBe(201);

    wpId = listServices(projectId).find((service) => service.kind === 'app')!.id;
    expect(await settled(wpId)).toBe('running');
  }, 900_000);

  afterAll(async () => {
    await stopAllDeployments();
    expect(activeJobCount()).toBe(0);
    for (const project of listProjects()) {
      const containers = await listContainers(labelFilter({ [LABELS.project]: project.id })).catch(
        () => [],
      );
      for (const container of containers) {
        await destroyContainer(container.Id, 2).catch(() => undefined);
      }
      await removeNetwork(project.id).catch(() => undefined);
    }
    closeDb();
    await rm(dir, { recursive: true, force: true });
  }, 180_000);

  test('the whole walk: install, sign in, updates, staging, push-to-live', async () => {
    // WP first boot copies its files into the volume and MySQL initialises in
    // parallel; neither is instant. Wait until WP-CLI can genuinely reach both.
    const ready = Date.now() + 240_000;
    while (Date.now() < ready) {
      const check = await runWp(wpId, ['db', 'check']).catch(() => ({ code: 1, out: '' }));
      if (check.code === 0) break;
      await Bun.sleep(3000);
    }

    // WP-CLI in the borrowed world: finish the famous five-minute install.
    const service = findService(wpId)!;
    const install = await runWp(wpId, [
      'core',
      'install',
      '--url=http://wp-walk.test',
      '--title=Original Title',
      '--admin_user=keeper',
      '--admin_password=correct-horse-battery',
      '--admin_email=keeper@example.com',
      '--skip-email',
    ]);
    expect(install.code).toBe(0);

    // 1. The sign-in link: one-time token, admin user, mu-plugin in place.
    const url = await adminLoginUrl(wpId);
    expect(url).toMatch(/\?derailed_login=[A-Za-z0-9]{40,}$/);
    const door = await runWp(wpId, [
      'eval',
      'echo file_exists(WP_CONTENT_DIR . "/mu-plugins/derailed-login.php") ? "yes" : "no";',
    ]);
    expect(door.out).toContain('yes');

    // 2. The update list answers in shapes the screen can use.
    const updates = await listWpUpdates(wpId);
    expect(updates.core.current).toMatch(/^\d+\./);
    expect(Array.isArray(updates.plugins)).toBe(true);

    // 3. The staging copy: own database, own files, rewritten links.
    const staging = await createStaging(wpId);
    expect(stagingOf(wpId)?.id).toBe(staging.id);
    const stagingTitle = await runWp(staging.id, ['option', 'get', 'blogname']);
    expect(stagingTitle.out.trim().split('\n').pop()).toBe('Original Title');
    // Its database really is its own: renaming staging must not touch live.
    const renamed = await runWp(staging.id, ['option', 'update', 'blogname', 'Staged Title']);
    expect(renamed.code).toBe(0);
    const liveTitle = await runWp(wpId, ['option', 'get', 'blogname']);
    expect(liveTitle.out.trim().split('\n').pop()).toBe('Original Title');
    // And its links point at itself, not at production.
    const stagingUrl = await runWp(staging.id, ['option', 'get', 'siteurl']);
    expect(stagingUrl.out).toContain(findService(staging.id)!.slug);

    // 4. Push-to-live: the staged change arrives, with the way back written down.
    const pushed = await pushStagingLive(wpId);
    expect(pushed.backupId).toBeTruthy();
    const after = await runWp(wpId, ['option', 'get', 'blogname']);
    expect(after.out.trim().split('\n').pop()).toBe('Staged Title');
    // The live site's links point home again, exactly as they were before,
    // not at staging: the rewrite is a round trip.
    const liveUrl = await runWp(wpId, ['option', 'get', 'siteurl']);
    expect(liveUrl.out.trim().split('\n').pop()).toBe('http://wp-walk.test');
    expect(service.id).toBeTruthy();
  }, 1_800_000);
});
