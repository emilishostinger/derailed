import { db } from '../db/index.ts';
import { listEnv, replaceUserEnv } from '../db/repo/env.ts';
import { findProject } from '../db/repo/projects.ts';
import {
  createAppService,
  findService,
  listServices,
  repoToken,
  softDeleteService,
} from '../db/repo/services.ts';
import { destroyContainer, listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
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

/**
 * Makes a copy of an app for one branch.
 *
 * The variables come across, because a preview with no database connection is a
 * preview that cannot start and teaches nobody anything. It shares the real app's
 * database rather than getting one of its own: a copy per branch would mean migrating
 * each of them, and the honest version of this feature at this size is "the same
 * data, the other code".
 */
export function createPreview(appId: string, branch: string): string | null {
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

  queueDeployment(preview.id, 'manual');
  return preview.id;
}

/** Takes one away, containers and all. */
export async function removePreview(previewId: string): Promise<void> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: previewId })).catch(
    () => [],
  );
  for (const container of containers) {
    await destroyContainer(container.Id, 5).catch(() => undefined);
  }
  // Into the trash rather than deleted outright, so a branch removed by mistake is
  // not a preview whose logs are gone before anybody read them.
  softDeleteService(previewId);
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
    const id = createPreview(appId, branch);
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
