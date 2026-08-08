import type { Service } from '@derailed/shared';
import { createBackup } from '../backup/backup.ts';
import { listSnapshots, restoreSnapshot, takeSnapshot } from '../backup/snapshots.ts';
import { FriendlyError } from '../build/git.ts';
import { queueDeployment } from '../build/pipeline.ts';
import { createDatabaseFromCatalog, credentialsFor } from '../catalog/create.ts';
import { db } from '../db/index.ts';
import { findDeployment } from '../db/repo/deployments.ts';
import { listDomains } from '../db/repo/domains.ts';
import { listEnv, replaceUserEnv, setEnv } from '../db/repo/env.ts';
import { linksFrom } from '../db/repo/links.ts';
import { findProject } from '../db/repo/projects.ts';
import { createAppService, findService, softDeleteService } from '../db/repo/services.ts';
import { createVolume, listVolumesFor } from '../db/repo/volumes.ts';
import { dockerFetch, dockerJson } from '../docker/client.ts';
import { destroyContainer, listContainers } from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { LABELS, labelFilter, managedLabels } from '../docker/labels.ts';
import { projectNetworkName } from '../docker/networks.ts';
import { demultiplex } from '../jobs/run.ts';
import { publicPortSuffix } from '../proxy/caddy.ts';

/**
 * WordPress superpowers.
 *
 * The most-run app on earth, given house treatment: sign in to wp-admin without a
 * password, update plugins and themes behind the same backup-first promise app
 * updates keep, and a staging copy with push-to-live. Four buttons on an app that
 * already exists.
 *
 * All of it drives WP-CLI, WordPress's own command line, run in a throwaway
 * `wordpress:cli` container that borrows the app's volumes, environment and
 * network. Nothing is installed into anyone's site except one four-line
 * must-use plugin for the sign-in link, and that only when the button is pressed.
 */

export function isWordPress(service: Service | null): boolean {
  return (
    service?.kind === 'app' &&
    service.source === 'image' &&
    (service.image ?? '').startsWith('wordpress')
  );
}

export class WordPressError extends FriendlyError {}

function requireWordPress(serviceId: string): Service {
  const service = findService(serviceId);
  if (!isWordPress(service)) {
    throw new WordPressError(
      'This is not a WordPress app.',
      'These buttons drive WP-CLI, which only means something inside WordPress.',
    );
  }
  return service!;
}

async function runningContainerOf(serviceId: string): Promise<string> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  const running = containers.find((container) => container.State === 'running');
  if (!running) {
    throw new WordPressError('The app is not running.', 'Start it first; WP-CLI works inside it.');
  }
  return running.Id;
}

/** The CLI image matched to the site's own PHP, so extensions line up. */
function cliImageFor(service: Service): string {
  const tag = service.image?.split(':')[1] ?? '';
  const php = /php(\d+\.\d+)/.exec(tag)?.[1];
  return php ? `wordpress:cli-php${php}` : 'wordpress:cli';
}

/**
 * One WP-CLI command, in a throwaway container that borrows the site's world:
 * its volumes (VolumesFrom), its environment (so WORDPRESS_DB_* point at the same
 * database), its network, and www-data's uid so nothing it writes is owned by root.
 */
export async function runWp(
  serviceId: string,
  args: string[],
  timeoutMs = 5 * 60_000,
): Promise<{ code: number; out: string }> {
  const service = requireWordPress(serviceId);
  const containerId = await runningContainerOf(serviceId);
  const inspected = await dockerJson<{ Config?: { Env?: string[] } }>(
    `/containers/${containerId}/json`,
  );

  const image = cliImageFor(service);
  if (!(await imageExists(image))) await pullImage(image);

  const { Id } = await dockerJson<{ Id: string }>('/containers/create', {
    method: 'POST',
    json: {
      Image: image,
      Cmd: ['wp', ...args],
      Env: inspected.Config?.Env ?? [],
      User: '33:33',
      WorkingDir: '/var/www/html',
      Labels: managedLabels({ role: 'build' }),
      HostConfig: {
        VolumesFrom: [containerId],
        NetworkMode: projectNetworkName(service.projectId),
      },
    },
  });

  try {
    await dockerFetch(`/containers/${Id}/start`, { method: 'POST' });
    await dockerFetch(`/containers/${Id}/wait`, { method: 'POST', timeoutMs });
    // The daemon writes the log file a beat after /wait answers, so an immediate
    // read comes back empty and every command looks silent. Found the hard way;
    // poll briefly, and only accept silence once it has had two seconds to speak.
    let out = '';
    const logsDeadline = Date.now() + 2000;
    while (true) {
      const logs = await dockerFetch(`/containers/${Id}/logs?stdout=1&stderr=1`, {});
      out = demultiplex(new Uint8Array(await logs.arrayBuffer()));
      if (out.length > 0 || Date.now() > logsDeadline) break;
      await Bun.sleep(150);
    }
    const status = await dockerJson<{ State?: { ExitCode?: number } }>(`/containers/${Id}/json`);
    return { code: status.State?.ExitCode ?? 1, out };
  } finally {
    await dockerFetch(`/containers/${Id}?force=true`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/** The site's best public address, the one a sign-in link should open on. */
function addressOf(service: Service): string {
  const domains = listDomains(service.id).filter((domain) => !domain.redirectTo);
  const best =
    domains.find((domain) => domain.kind === 'custom' && domain.tlsStatus === 'active') ??
    domains.find((domain) => domain.tlsStatus === 'active') ??
    domains[0];
  if (!best) {
    throw new WordPressError('This app has no web address yet.', 'Give it a domain first.');
  }
  const https = best.tlsStatus === 'active';
  return `${https ? 'https' : 'http'}://${best.hostname}${publicPortSuffix(https)}`;
}

/** The four-line door the sign-in link knocks on. Single-use, five minutes. */
const LOGIN_PLUGIN = `<?php
/* Written by Derailed: one-time sign-in links from the dashboard. Safe to delete. */
add_action('init', function () {
  if (!isset($_GET['derailed_login'])) { return; }
  $token = preg_replace('/[^A-Za-z0-9]/', '', (string) $_GET['derailed_login']);
  if ($token === '') { return; }
  $user_id = get_transient('derailed_login_' . $token);
  if (!$user_id) { wp_die('That sign-in link has been used or has expired. Ask the dashboard for a fresh one.'); }
  delete_transient('derailed_login_' . $token);
  wp_set_auth_cookie((int) $user_id, false);
  wp_safe_redirect(admin_url());
  exit;
});
`;

export function loginPluginSource(): string {
  return LOGIN_PLUGIN;
}

/**
 * One press, one signed-in wp-admin.
 *
 * A one-time token goes into a transient (five minutes, deleted on use) and the
 * answer is a link that logs in the site's first administrator. The mu-plugin that
 * honours the link is (re)written on each press, so deleting it costs nothing.
 */
export async function adminLoginUrl(serviceId: string): Promise<string> {
  const service = requireWordPress(serviceId);

  const written = await runWp(serviceId, [
    'eval',
    `if (!is_dir(WP_CONTENT_DIR . '/mu-plugins')) { mkdir(WP_CONTENT_DIR . '/mu-plugins', 0755, true); }
     file_put_contents(WP_CONTENT_DIR . '/mu-plugins/derailed-login.php', base64_decode('${Buffer.from(
       LOGIN_PLUGIN,
     ).toString('base64')}'));`,
  ]);
  if (written.code !== 0) {
    throw new WordPressError(
      'The sign-in door could not be written.',
      written.out.trim().slice(-300),
    );
  }

  const minted = await runWp(serviceId, [
    'eval',
    `$us = get_users(['role__in' => ['administrator'], 'number' => 1, 'orderby' => 'ID']);
     if (!$us) { echo 'NOADMIN'; }
     else { $t = wp_generate_password(43, false, false);
            set_transient('derailed_login_' . $t, $us[0]->ID, 300);
            echo $t; }`,
  ]);
  const token = minted.out.trim().split('\n').pop() ?? '';
  if (minted.code !== 0 || token === 'NOADMIN' || !/^[A-Za-z0-9]{20,}$/.test(token)) {
    throw new WordPressError(
      token === 'NOADMIN'
        ? 'This WordPress has no administrator yet.'
        : 'A sign-in link could not be minted.',
      token === 'NOADMIN'
        ? 'Open the site and finish the WordPress setup first.'
        : minted.out.trim().slice(-300),
    );
  }
  return `${addressOf(service)}/?derailed_login=${token}`;
}

export interface WpUpdates {
  core: { current: string; available: string | null };
  plugins: { name: string; version: string; available: string }[];
  themes: { name: string; version: string; available: string }[];
}

/** What is waiting, in WP-CLI's own words, reshaped for a screen. */
export async function listWpUpdates(serviceId: string): Promise<WpUpdates> {
  requireWordPress(serviceId);
  const parse = <T>(out: string): T | null => {
    // WP-CLI sometimes prints notices before the JSON; the array is the answer.
    const start = out.indexOf('[');
    if (start === -1) return null;
    try {
      return JSON.parse(out.slice(start)) as T;
    } catch {
      return null;
    }
  };

  const [version, core, plugins, themes] = await Promise.all([
    runWp(serviceId, ['core', 'version']),
    runWp(serviceId, ['core', 'check-update', '--format=json']),
    runWp(serviceId, ['plugin', 'list', '--update=available', '--format=json']),
    runWp(serviceId, ['theme', 'list', '--update=available', '--format=json']),
  ]);

  const coreUpdates = parse<{ version: string }[]>(core.out) ?? [];
  return {
    core: {
      current: version.out.trim().split('\n').pop() ?? '',
      available: coreUpdates[0]?.version ?? null,
    },
    plugins: (
      parse<{ name: string; version: string; update_version?: string }[]>(plugins.out) ?? []
    ).map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      available: plugin.update_version ?? 'newer',
    })),
    themes: (
      parse<{ name: string; version: string; update_version?: string }[]>(themes.out) ?? []
    ).map((theme) => ({
      name: theme.name,
      version: theme.version,
      available: theme.update_version ?? 'newer',
    })),
  };
}

/**
 * Plugin, theme and core updates, behind the same promise as app updates: the
 * copy comes first, and if it cannot be taken, nothing is touched.
 */
export async function updateWordPress(
  serviceId: string,
  what: 'plugins' | 'themes' | 'core' | 'all',
): Promise<{ backupId: string; report: string }> {
  const service = requireWordPress(serviceId);

  const backup = await createBackup(service.projectId).catch((err) => {
    throw new WordPressError(
      `${err instanceof Error ? err.message : 'The backup could not be taken.'} Nothing was updated: the copy comes first.`,
    );
  });

  const lines: string[] = [];
  const steps: [string, string[]][] = [];
  if (what === 'plugins' || what === 'all') steps.push(['plugins', ['plugin', 'update', '--all']]);
  if (what === 'themes' || what === 'all') steps.push(['themes', ['theme', 'update', '--all']]);
  if (what === 'core' || what === 'all') steps.push(['core', ['core', 'update']]);

  for (const [label, args] of steps) {
    const result = await runWp(serviceId, args, 15 * 60_000);
    const tail = result.out.trim().split('\n').slice(-3).join(' ');
    lines.push(result.code === 0 ? `${label}: ${tail || 'done'}` : `${label} FAILED: ${tail}`);
    if (result.code !== 0) {
      throw new WordPressError(
        `Updating ${label} failed. The backup taken first is on the Backups page.`,
        lines.join(' · '),
      );
    }
  }
  return { backupId: backup.id, report: lines.join(' · ') };
}

function markStagingOf(stagingId: string, liveId: string): void {
  db().query('UPDATE services SET preview_of = ? WHERE id = ?').run(liveId, stagingId);
}

/** The staging copy of this app, when one exists. */
export function stagingOf(liveId: string): Service | null {
  const row = db()
    .query<{ id: string }, [string]>(
      `SELECT id FROM services WHERE preview_of = ? AND deleted_at IS NULL AND kind = 'app'`,
    )
    .get(liveId);
  return row ? findService(row.id) : null;
}

/** Copies every file from one named volume into another, through a scratch container. */
async function copyVolume(fromVolume: string, toVolume: string, wipeFirst: boolean): Promise<void> {
  const image = 'alpine:3.20';
  if (!(await imageExists(image))) await pullImage(image);
  const script = wipeFirst
    ? 'find /to -mindepth 1 -delete && cp -a /from/. /to/'
    : 'cp -a /from/. /to/';
  const { Id } = await dockerJson<{ Id: string }>('/containers/create', {
    method: 'POST',
    json: {
      Image: image,
      Cmd: ['sh', '-c', script],
      Labels: managedLabels({ role: 'build' }),
      HostConfig: { Binds: [`${fromVolume}:/from:ro`, `${toVolume}:/to`] },
    },
  });
  try {
    await dockerFetch(`/containers/${Id}/start`, { method: 'POST' });
    await dockerFetch(`/containers/${Id}/wait`, { method: 'POST', timeoutMs: 10 * 60_000 });
    const status = await dockerJson<{ State?: { ExitCode?: number } }>(`/containers/${Id}/json`);
    if ((status.State?.ExitCode ?? 1) !== 0) {
      throw new WordPressError('Copying the site files did not finish cleanly.');
    }
  } finally {
    await dockerFetch(`/containers/${Id}?force=true`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function settleDeployment(deploymentId: string, timeoutMs = 15 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = findDeployment(deploymentId);
    if (deployment?.finishedAt) return deployment.status;
    await Bun.sleep(500);
  }
  return 'timeout';
}

/**
 * A staging copy: the same image, a real copy of the database, a real copy of the
 * files, its own address, and the URLs inside rewritten so it browses as itself.
 * Ordinary service underneath, so every existing screen works on it.
 */
export async function createStaging(liveId: string): Promise<Service> {
  const live = requireWordPress(liveId);
  if (stagingOf(liveId)) {
    throw new WordPressError(
      'There is already a staging copy.',
      'Push it live or delete it first.',
    );
  }
  const project = findProject(live.projectId);
  if (!project) throw new WordPressError('That project no longer exists.');

  const link = linksFrom(live.id)
    .map((entry) => findService(entry.toServiceId))
    .find((entry) => entry?.kind === 'database');
  if (!link) {
    throw new WordPressError(
      'This WordPress has no linked database Derailed knows about.',
      'Staging copies the database, so it has to be one Derailed manages.',
    );
  }

  const madeIds: string[] = [];
  const undo = async () => {
    for (const id of madeIds) {
      const containers = await listContainers(labelFilter({ [LABELS.service]: id })).catch(
        () => [],
      );
      for (const container of containers) await destroyContainer(container.Id, 5).catch(() => {});
      softDeleteService(id);
    }
  };

  try {
    // 1. The database copy, from the newest hourly snapshot (or one taken now).
    const snapshot = listSnapshots(link.id)[0] ?? (await takeSnapshot(link.id));
    if (!snapshot) {
      throw new WordPressError('A copy of the database could not be taken.');
    }
    const cloneDb = await createDatabaseFromCatalog(
      live.projectId,
      `${link.name} staging`,
      link.dbEngine!,
      link.dbVersion ?? '',
    );
    madeIds.push(cloneDb.id);
    markStagingOf(cloneDb.id, link.id);
    if (!(await waitHealthy(cloneDb.id))) {
      throw new WordPressError('The database copy did not come up in time.');
    }
    await restoreSnapshot(snapshot.id, cloneDb.id);

    // 2. The app copy, aimed at the database copy rather than at production.
    const staging = createAppService({
      projectId: live.projectId,
      name: `${live.name} staging`,
      source: 'image',
      image: live.image,
      framework: live.framework,
      repoUrl: null,
      branch: null,
      port: live.port ?? 80,
      healthPath: live.healthPath,
    });
    madeIds.push(staging.id);
    markStagingOf(staging.id, live.id);

    const cloneCredentials = credentialsFor(cloneDb)!;
    const inherited = listEnv(live.id)
      .filter((entry) => entry.source === 'user' && !entry.key.startsWith('WORDPRESS_DB_'))
      .map((entry) => ({ key: entry.key, value: entry.value }));
    replaceUserEnv(staging.id, inherited);
    setEnv(staging.id, 'WORDPRESS_DB_HOST', `${cloneCredentials.host}:3306`, 'user');
    setEnv(staging.id, 'WORDPRESS_DB_NAME', cloneCredentials.dbName, 'user');
    setEnv(staging.id, 'WORDPRESS_DB_USER', cloneCredentials.user, 'user');
    setEnv(staging.id, 'WORDPRESS_DB_PASSWORD', cloneCredentials.password, 'user');

    // 3. The files: same mount paths, contents copied before first start.
    for (const volume of listVolumesFor(live.id)) {
      const made = createVolume(staging.id, volume.containerPath);
      await copyVolume(volume.name, made.name, false);
    }

    // 4. Deploy, and only then rewrite the URLs inside to the staging address.
    const outcome = await settleDeployment(queueDeployment(staging.id, 'manual').id);
    if (outcome !== 'running') {
      throw new WordPressError('The staging copy did not come up.', `The deploy ${outcome}.`);
    }

    // The source of the rewrite is what the site says about itself, not what
    // Derailed assumes: siteurl is whatever address WordPress was set up through,
    // and rewriting a guess would rewrite nothing.
    const from = await siteUrlOf(staging.id);
    const to = addressOf(findService(staging.id)!);
    const replaced = await runWp(staging.id, [
      'search-replace',
      from,
      to,
      '--all-tables',
      '--report-changed-only',
    ]);
    if (replaced.code !== 0) {
      throw new WordPressError(
        'The staging copy is up but its links could not be rewritten.',
        replaced.out.trim().slice(-300),
      );
    }
    return findService(staging.id)!;
  } catch (err) {
    await undo();
    throw err;
  }
}

async function waitHealthy(serviceId: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
      () => [],
    );
    const running = containers.find((container) => container.State === 'running');
    if (running) {
      const inspected = await dockerJson<{ State?: { Health?: { Status?: string } } }>(
        `/containers/${running.Id}/json`,
      ).catch(() => null);
      const health = inspected?.State?.Health?.Status;
      if (!health || health === 'healthy') return true;
    }
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * Push-to-live: the staging copy's database and files become production's, with
 * the way back written down first. The whole project is backed up before anything
 * moves, and if the copy cannot be taken, nothing moves. URLs are rewritten back
 * on arrival so the live site browses as itself.
 */
export async function pushStagingLive(liveId: string): Promise<{ backupId: string }> {
  const live = requireWordPress(liveId);
  const staging = stagingOf(liveId);
  if (!staging) throw new WordPressError('There is no staging copy to push.');

  const liveDb = linksFrom(live.id)
    .map((entry) => findService(entry.toServiceId))
    .find((entry) => entry?.kind === 'database');
  const stagingDb = stagingDatabaseOf(staging);
  if (!liveDb || !stagingDb) {
    throw new WordPressError('The pair of databases could not be found.');
  }

  // What each site calls itself, read BEFORE anything moves: after the restore,
  // the live database says the staging address, and the original is only in
  // these two variables and the backup.
  const liveUrl = await siteUrlOf(live.id);
  const stagingUrl = await siteUrlOf(staging.id);

  // The copy first. Not a setting.
  const backup = await createBackup(live.projectId).catch((err) => {
    throw new WordPressError(
      `${err instanceof Error ? err.message : 'The backup could not be taken.'} Nothing was pushed: the copy comes first.`,
    );
  });

  // Database: snapshot staging now, restore it into live.
  const snapshot = await takeSnapshot(stagingDb.id);
  if (!snapshot) throw new WordPressError('A copy of the staging database could not be taken.');
  await restoreSnapshot(snapshot.id, liveDb.id);

  // Files: staging's volume contents replace live's, deletions included.
  const stagingVolumes = new Map(
    listVolumesFor(staging.id).map((volume) => [volume.containerPath, volume.name]),
  );
  for (const volume of listVolumesFor(live.id)) {
    const source = stagingVolumes.get(volume.containerPath);
    if (source) await copyVolume(source, volume.name, true);
  }

  // And the URLs point home again.
  const replaced = await runWp(live.id, [
    'search-replace',
    stagingUrl,
    liveUrl,
    '--all-tables',
    '--report-changed-only',
  ]);
  if (replaced.code !== 0) {
    throw new WordPressError(
      'The push landed but the links could not be rewritten back.',
      `Restore the backup from the Backups page if the site looks wrong. ${replaced.out
        .trim()
        .slice(-200)}`,
    );
  }
  return { backupId: backup.id };
}

/** What the site calls itself: siteurl, which every link inside hangs off. */
async function siteUrlOf(serviceId: string): Promise<string> {
  const result = await runWp(serviceId, ['option', 'get', 'siteurl']);
  const url = result.out.trim().split('\n').pop() ?? '';
  if (result.code !== 0 || !/^https?:\/\//.test(url)) {
    throw new WordPressError(
      'The site would not say its own address.',
      result.out.trim().slice(-200),
    );
  }
  return url;
}

function stagingDatabaseOf(staging: Service): Service | null {
  // The staging DB is the database-kind service marked as a copy, in the same
  // project, that the staging app's WORDPRESS_DB_NAME points at.
  const dbName = listEnv(staging.id).find((entry) => entry.key === 'WORDPRESS_DB_NAME')?.value;
  const rows = db()
    .query<{ id: string }, [string]>(
      `SELECT id FROM services WHERE preview_of IS NOT NULL AND deleted_at IS NULL AND kind = 'database' AND project_id = ?`,
    )
    .all(staging.projectId);
  for (const row of rows) {
    const candidate = findService(row.id);
    if (candidate && candidate.dbName === dbName) return candidate;
  }
  return null;
}

/** Everything the WordPress tab needs in one answer. */
export async function wordPressState(serviceId: string): Promise<{
  isWordPress: boolean;
  staging: { id: string; name: string } | null;
}> {
  const service = findService(serviceId);
  if (!isWordPress(service)) return { isWordPress: false, staging: null };
  const staging = stagingOf(serviceId);
  return {
    isWordPress: true,
    staging: staging ? { id: staging.id, name: staging.name } : null,
  };
}
