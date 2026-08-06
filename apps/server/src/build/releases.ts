import { listServices, repoToken, updateService } from '../db/repo/services.ts';
import { publish } from '../events/bus.ts';
import { queueDeployment } from './pipeline.ts';

/**
 * Deploying when a new release is published.
 *
 * Polled rather than pushed. A webhook would be faster by a couple of minutes and
 * would cost the person running this a public URL, a shared secret, and a trip into
 * GitHub's settings for every repository. Derailed is frequently behind a router or
 * on a machine that GitHub cannot reach at all, and "it silently stopped working"
 * is the usual end of a webhook nobody is watching. Asking GitHub every few minutes
 * needs no configuration and cannot break in that direction.
 *
 * Releases specifically, not pushes. A push to the default branch is a work in
 * progress; tagging a release is somebody saying this one is meant to be out there.
 */

/** Owner and repository, for anything that looks like a GitHub URL. */
export function githubRepo(repoUrl: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const match = /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    repoUrl.trim(),
  );
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

export interface Release {
  tag: string;
  name: string;
  url: string;
  publishedAt: number | null;
  prerelease: boolean;
}

/**
 * The newest published release, or null when the repository has none.
 *
 * `/releases/latest` is deliberately not used: it hides prereleases *and* draft
 * releases, so a repository whose most recent release is a prerelease answers with
 * an older tag, and Derailed would notice a "new" release that is actually older
 * than the one running. Listing gives the truth, and the caller decides.
 */
export async function latestRelease(
  repoUrl: string | null,
  token?: string | null,
  { includePrereleases = false }: { includePrereleases?: boolean } = {},
): Promise<Release | null> {
  const repo = githubRepo(repoUrl);
  if (!repo) return null;

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'derailed',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
      repo.repo,
    )}/releases?per_page=20`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  // A 404 on a repository we can otherwise see means it has no releases; a 403 is
  // the rate limit. Neither is worth an alarm, and neither should move the tag we
  // have stored, so both come back as "nothing new".
  if (!response.ok) return null;

  const releases = (await response.json()) as {
    tag_name?: string;
    name?: string | null;
    html_url?: string;
    published_at?: string | null;
    draft?: boolean;
    prerelease?: boolean;
  }[];
  if (!Array.isArray(releases)) return null;

  const usable = releases.filter(
    (release) =>
      release.tag_name &&
      !release.draft &&
      (includePrereleases || !release.prerelease) &&
      release.published_at,
  );
  if (!usable.length) return null;

  // GitHub returns them newest first by creation, which is not the same as published
  // order once somebody edits an old draft. Sorting on the published date is what
  // makes "newest" mean what a person reading the releases page would say it means.
  usable.sort((a, b) => Date.parse(b.published_at ?? '') - Date.parse(a.published_at ?? ''));
  const newest = usable[0]!;

  return {
    tag: newest.tag_name!,
    name: newest.name?.trim() || newest.tag_name!,
    url: newest.html_url ?? '',
    publishedAt: newest.published_at ? Date.parse(newest.published_at) : null,
    prerelease: newest.prerelease === true,
  };
}

/**
 * Notes today's release without deploying it, when the setting is switched on.
 *
 * The watcher would do this on its next pass anyway, but ten minutes of "following
 * releases" with nothing to show is indistinguishable from a setting that did not
 * save. Doing it here means the drawer can name the release it is watching from the
 * moment the switch moves.
 */
export async function adoptCurrentRelease(serviceId: string): Promise<string | null> {
  const service = listServices().find((entry) => entry.id === serviceId);
  if (!service || service.lastReleaseTag) return service?.lastReleaseTag ?? null;

  const release = await latestRelease(service.repoUrl, repoToken(serviceId)).catch(() => null);
  if (!release) return null;
  updateService(serviceId, { lastReleaseTag: release.tag });
  return release.tag;
}

export interface ReleaseCheck {
  serviceId: string;
  serviceName: string;
  tag: string;
  /** False the first time, when the current release is merely being noted. */
  deployed: boolean;
}

/**
 * One pass over everything set to follow releases.
 *
 * The first tag seen for a service is recorded and not deployed. Switching this on
 * should not immediately rebuild an app that is already running the current release,
 * which is what "deploy the newest tag" would do to every app the moment the setting
 * appeared.
 */
export async function checkReleases(): Promise<ReleaseCheck[]> {
  const done: ReleaseCheck[] = [];

  for (const service of listServices()) {
    if (service.kind !== 'app' || !service.deployOnRelease) continue;
    if (!githubRepo(service.repoUrl)) continue;

    const release = await latestRelease(service.repoUrl, repoToken(service.id)).catch(() => null);
    if (!release || release.tag === service.lastReleaseTag) continue;

    const first = service.lastReleaseTag === null;
    updateService(service.id, { lastReleaseTag: release.tag });

    if (first) {
      done.push({
        serviceId: service.id,
        serviceName: service.name,
        tag: release.tag,
        deployed: false,
      });
      continue;
    }

    queueDeployment(service.id, 'release', undefined, release.tag);
    publish('system', {
      type: 'notice',
      level: 'info',
      message: `${service.name}: deploying ${release.tag}, just published on GitHub.`,
    });
    done.push({
      serviceId: service.id,
      serviceName: service.name,
      tag: release.tag,
      deployed: true,
    });
  }

  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Every ten minutes. GitHub allows sixty unauthenticated calls an hour per address,
 * so this stays well inside it even with a handful of apps following releases, and
 * nobody publishes a release they need deployed within the minute.
 */
const INTERVAL_MS = 10 * 60 * 1000;

export function startReleaseWatcher(): void {
  if (timer) return;
  timer = setInterval(() => void checkReleases().catch(() => undefined), INTERVAL_MS);
  timer.unref?.();
  // Not on boot: a restart would then be a deploy trigger, and restarts happen for
  // reasons that have nothing to do with anyone publishing anything.
}

export function stopReleaseWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
