import { listSnapshots, restoreSnapshot, takeSnapshot } from '../backup/snapshots.ts';
import { createDatabaseFromCatalog } from '../catalog/create.ts';
import { connectServices } from '../catalog/links.ts';
import { db } from '../db/index.ts';
import { deleteEnv, listEnv, replaceUserEnv } from '../db/repo/env.ts';
import { linksFrom } from '../db/repo/links.ts';
import { findProject } from '../db/repo/projects.ts';
import {
  createAppService,
  findService,
  listServices,
  repoToken,
  softDeleteService,
} from '../db/repo/services.ts';
import { destroyContainer, inspectContainer, listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { publish } from '../events/bus.ts';
import { setSleepAfter } from '../runtime/sleep.ts';
import { listBranches } from './git.ts';
import { queueDeployment } from './pipeline.ts';

/**
 * A copy of an app, per branch.
 *
 * The flagship feature of every platform people pay twenty pounds a month for, and
 * every piece of it was already here: git polling that notices a push, a container
 * per service, wildcard routing that hands out an address to anything new. The only
 * new idea is "a branch is a temporary copy of this app".
 *
 * A preview is an ordinary service with two extra columns saying what it is a copy of
 * and which branch it follows. Ordinary on purpose: every screen already works on it,
 * the logs work, the terminal works, the variables work, and none of them had to be
 * taught what a preview is.
 *
 * It goes when the branch does. That is the part people forget to do by hand, and the
 * reason a server fills up with copies of work finished in March.
 */

/** The default branch never gets a preview: it is the app itself. */
function isPreviewable(branch: string, mainBranch: string | null): boolean {
  if (branch === mainBranch) return false;
  return /^[A-Za-z0-9._\-/]{1,80}$/.test(branch);
}

/** `shop-web` plus the branch, which is what the address ends up reading as. */
export function previewName(appName: string, branch: string): string {
  const tidy = branch
    .replace(/^(feature|feat|fix|chore)\//, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return `${appName} · ${tidy}`;
}

export function previewsFor(appId: string) {
  return db()
    .query<{ id: string }, [string]>(
      'SELECT id FROM services WHERE preview_of = ? AND deleted_at IS NULL',
    )
    .all(appId)
    .map((row) => findService(row.id))
    .filter((service) => service !== null);
}

export function previewsEnabled(appId: string): boolean {
  const row = db()
    .query<{ preview_branches: 0 | 1 }, [string]>(
      'SELECT preview_branches FROM services WHERE id = ?',
    )
    .get(appId);
  return row?.preview_branches === 1;
}

export function setPreviews(appId: string, on: boolean): void {
  db()
    .query('UPDATE services SET preview_branches = ? WHERE id = ?')
    .run(on ? 1 : 0, appId);
}

function markAsPreview(previewId: string, appId: string): void {
  db().query('UPDATE services SET preview_of = ? WHERE id = ?').run(appId, previewId);
}

/** Whether previews of this app get their own copy of its data. */
export function previewData(appId: string): { mode: 'shared' | 'clone'; scrub: string | null } {
  const row = db()
    .query<{ preview_data: 'shared' | 'clone'; preview_scrub: string | null }, [string]>(
      'SELECT preview_data, preview_scrub FROM services WHERE id = ?',
    )
    .get(appId);
  return { mode: row?.preview_data ?? 'shared', scrub: row?.preview_scrub ?? null };
}

export function setPreviewData(
  appId: string,
  mode: 'shared' | 'clone',
  scrub?: string | null,
): void {
  db()
    .query('UPDATE services SET preview_data = ?, preview_scrub = ? WHERE id = ?')
    .run(mode, scrub?.trim() || null, appId);
}

/** Waits for a fresh database container to report itself healthy. */
async function waitDbHealthy(serviceId: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
      () => [],
    );
    const running = containers.find((container) => container.State === 'running');
    if (running) {
      const inspected = (await inspectContainer(running.Id).catch(() => null)) as {
        State?: { Health?: { Status?: string } };
      } | null;
      if (inspected?.State?.Health?.Status === 'healthy') return true;
    }
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * Gives one preview its own copy of every database the real app is linked to.
 *
 * The copy comes from the newest hourly snapshot, or one taken on the spot: the
 * machinery the Copies tab already trusts, pointed at a fresh database of the
 * same engine and version. Redis and Valkey clones start empty, because their
 * dumps cannot be fed to a running server and a cache is meant to warm itself.
 */
async function cloneDatabasesFor(
  app: NonNullable<ReturnType<typeof findService>>,
  previewId: string,
  branch: string,
  scrub: string | null,
): Promise<void> {
  const { restoreCommandFor, execArgs } = await import('../backup/backup.ts');
  const { findEngine } = await import('../catalog/databases.ts');
  const { credentialsFor } = await import('../catalog/create.ts');

  for (const link of linksFrom(app.id)) {
    const database = findService(link.toServiceId);
    if (database?.kind !== 'database' || !database.dbEngine) continue;

    const snapshot =
      listSnapshots(database.id)[0] ?? (await takeSnapshot(database.id).catch(() => null));

    const clone = await createDatabaseFromCatalog(
      app.projectId,
      previewName(database.name, branch),
      database.dbEngine,
      database.dbVersion ?? '',
    );
    markAsPreview(clone.id, database.id);
    try {
      const healthy = await waitDbHealthy(clone.id);
      const engine = findEngine(database.dbEngine);
      const restorable =
        engine && restoreCommandFor(engine.engine, credentialsFor(clone)!) !== null;

      if (healthy && snapshot && restorable) {
        await restoreSnapshot(snapshot.id, clone.id);

        // The scrub, against the copy and only the copy, before anything serves it.
        if (scrub) {
          const credentials = credentialsFor(clone)!;
          // The command's author cannot know the copy's generated database name, so
          // the client's own environment variables carry it: `psql -c "UPDATE …"`
          // works bare, whatever the branch is called.
          const env = [
            ...(restoreCommandFor(engine.engine, credentials)?.env ?? []),
            `DB_NAME=${credentials.dbName}`,
            `DB_USER=${credentials.user}`,
            ...(engine.engine === 'postgres'
              ? [`PGUSER=${credentials.user}`, `PGDATABASE=${credentials.dbName}`]
              : []),
            ...(engine.engine === 'mysql' || engine.engine === 'mariadb'
              ? [`MYSQL_USER=${credentials.user}`, `MYSQL_DATABASE=${credentials.dbName}`]
              : []),
          ];
          const containers = await listContainers(labelFilter({ [LABELS.service]: clone.id }));
          const running = containers.find((container) => container.State === 'running');
          if (running) {
            const proc = Bun.spawn(['docker', ...execArgs(running.Id, env), 'sh', '-c', scrub], {
              stdout: 'pipe',
              stderr: 'pipe',
            });
            const [problem, code] = await Promise.all([
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            if (code !== 0) {
              // A scrub that failed and a preview that serves anyway is real people's
              // data where it was not supposed to be. The copy is emptied instead.
              throw new Error(
                `The scrub command failed, so the copy was not kept: ${problem.slice(0, 200)}`,
              );
            }
          }
        }
      }

      // The preview inherits the parent's user variables, and a hand-typed database
      // address among them would shadow the clone's own injection.
      const key = link.injectAs ?? engine?.defaultInjectKey ?? 'DATABASE_URL';
      deleteEnv(previewId, key);
      await connectServices(previewId, clone.id, link.injectAs ?? undefined);
    } catch (err) {
      // A half-made copy is worse than no preview: real data may be sitting in it
      // unscrubbed. It goes, whole, and the failure is loud.
      const containers = await listContainers(labelFilter({ [LABELS.service]: clone.id })).catch(
        () => [],
      );
      for (const container of containers) {
        await destroyContainer(container.Id, 5).catch(() => undefined);
      }
      softDeleteService(clone.id);
      throw err;
    }
  }
}

/**
 * Makes a copy of an app for one branch.
 *
 * The variables come across, because a preview with no database connection is a
 * preview that cannot start and teaches nobody anything. What the database *is*
 * depends on the app's setting: shared, the same data and the other code, or a
 * clone, a real copy of the real data that the preview may do anything to.
 */
export async function createPreview(appId: string, branch: string): Promise<string | null> {
  const app = findService(appId);
  const project = app && findProject(app.projectId);
  if (!app || !project || app.kind !== 'app' || !app.repoUrl) return null;

  const preview = createAppService({
    projectId: app.projectId,
    name: previewName(app.name, branch),
    source: 'repo',
    repoUrl: app.repoUrl,
    branch,
    rootDir: app.rootDir,
    buildStrategy: app.buildStrategy,
    dockerfilePath: app.dockerfilePath,
    port: app.port,
    healthPath: app.healthPath,
  });

  markAsPreview(preview.id, app.id);

  const inherited = listEnv(app.id)
    .filter((entry) => entry.source === 'user')
    .map((entry) => ({ key: entry.key, value: entry.value }));
  if (inherited.length) replaceUserEnv(preview.id, inherited);

  const data = previewData(app.id);
  if (data.mode === 'clone') {
    try {
      await cloneDatabasesFor(app, preview.id, branch, data.scrub);
    } catch (err) {
      // Deliberately not a quiet fall-back to the real database: the setting
      // promised a copy, and the one thing worse than a preview without data is
      // a preview quietly pointed at production.
      publish('system', {
        type: 'notice',
        level: 'error',
        message: `The preview for ${app.name} on ${branch} could not get its copy of the data: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  // A preview is by definition occasional. It naps after a quiet day and wakes
  // from the dashboard, rather than idling for the life of the branch.
  setSleepAfter(preview.id, 24 * 60);

  queueDeployment(preview.id, 'manual');
  return preview.id;
}

/** The cloned databases a preview drags along, found through its links. */
function clonesOf(previewId: string): string[] {
  return linksFrom(previewId)
    .map((link) => findService(link.toServiceId))
    .filter(
      (service) =>
        service?.kind === 'database' &&
        !!db()
          .query<{ preview_of: string | null }, [string]>(
            'SELECT preview_of FROM services WHERE id = ?',
          )
          .get(service.id)?.preview_of,
    )
    .map((service) => service!.id);
}

/** Takes one away, containers, cloned data and all. */
export async function removePreview(previewId: string): Promise<void> {
  for (const serviceId of [previewId, ...clonesOf(previewId)]) {
    const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
      () => [],
    );
    for (const container of containers) {
      await destroyContainer(container.Id, 5).catch(() => undefined);
    }
    // Into the trash rather than deleted outright, so a branch removed by mistake is
    // not a preview whose logs and data are gone before anybody looked.
    softDeleteService(serviceId);
  }
}

export interface PreviewSweep {
  created: string[];
  removed: string[];
}

/**
 * Matches previews to the branches that actually exist.
 *
 * Reads the branches from the repository, which is the same trick the push watcher
 * uses: no webhook, no public URL, and it works on a server GitHub cannot reach.
 */
export async function syncPreviews(appId: string): Promise<PreviewSweep> {
  const sweep: PreviewSweep = { created: [], removed: [] };

  const app = findService(appId);
  if (!app?.repoUrl || !previewsEnabled(appId)) return sweep;

  const branches = await listBranches(app.repoUrl, repoToken(appId)).catch(() => null);
  // A repository that cannot be read right now is not a repository with no branches.
  // Tearing every preview down over a network hiccup would be unforgivable.
  if (!branches) return sweep;

  const wanted = new Set(branches.filter((branch) => isPreviewable(branch, app.branch)));
  const existing = new Map(previewsFor(appId).map((preview) => [preview.branch ?? '', preview.id]));

  for (const branch of wanted) {
    if (existing.has(branch)) continue;
    const id = await createPreview(appId, branch);
    if (id) sweep.created.push(branch);
  }

  for (const [branch, id] of existing) {
    if (wanted.has(branch)) continue;
    await removePreview(id);
    sweep.removed.push(branch);
  }

  return sweep;
}

async function sweepAll(onLog?: (line: string) => void): Promise<void> {
  for (const service of listServices()) {
    if (service.kind !== 'app' || !previewsEnabled(service.id)) continue;
    const sweep = await syncPreviews(service.id).catch(() => null);
    if (!sweep) continue;
    for (const branch of sweep.created) onLog?.(`preview up for ${service.name} on ${branch}`);
    for (const branch of sweep.removed) onLog?.(`preview gone for ${service.name} on ${branch}`);
  }
}

/** Five minutes, which is the same cadence the push watcher already runs at. */
const INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startPreviewBranches(onLog?: (line: string) => void): void {
  if (timer) return;
  timer = setInterval(() => void sweepAll(onLog), INTERVAL_MS);
  timer.unref?.();
}

export function stopPreviewBranches(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
