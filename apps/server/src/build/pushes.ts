import { runningDeployment } from '../db/repo/deployments.ts';
import { listServices, repoToken, updateService } from '../db/repo/services.ts';
import { publish } from '../events/bus.ts';
import { resolveBranchHead } from './git.ts';
import { queueDeployment } from './pipeline.ts';

/**
 * Deploying when you push.
 *
 * This is what most people mean by "connect it to GitHub": you push to your branch
 * and the thing that is running catches up, without opening the dashboard. Its
 * sibling in `releases.ts` waits for a tagged release instead, which is the same idea
 * held to a higher bar, and the two are offered as one choice rather than two
 * switches, because wanting both is wanting the looser of them.
 *
 * Asked with `git ls-remote` rather than through GitHub's API, which matters more
 * than it sounds. The API allows sixty unauthenticated calls an hour per address, so
 * polling it every couple of minutes runs a handful of apps into the ceiling and then
 * silently stops noticing pushes. `ls-remote` is plain git: no token for a public
 * repository, no quota to run out of, and it works the same against GitLab,
 * Bitbucket, Gitea or a server somebody runs in their own house. Releases have to go
 * through the API because a release is a GitHub invention. A commit is not.
 *
 * Polled rather than pushed, for the reason spelled out in `releases.ts`: a webhook
 * needs a public URL, a shared secret and a trip into settings for every repository,
 * and it ends its life as something that quietly stopped working.
 */

/** Two minutes. A push is watched for; a release is not. */
const INTERVAL_MS = 2 * 60 * 1000;

export interface PushCheck {
  serviceId: string;
  serviceName: string;
  sha: string;
  /** False the first time, when the commit is merely being noted. */
  deployed: boolean;
}

/** `a1b2c3d` , what a person recognises a commit by. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * One pass over everything set to deploy on push.
 *
 * The first commit seen for a service is written down and not deployed. Switching
 * this on should not rebuild an app that is already running the top of its branch,
 * which is what "deploy the newest commit" would do to every app the moment the
 * setting appeared.
 */
export async function checkPushes(): Promise<PushCheck[]> {
  const done: PushCheck[] = [];

  for (const service of listServices()) {
    if (service.kind !== 'app' || !service.deployOnPush) continue;
    if (service.source !== 'repo' || !service.repoUrl || !service.branch) continue;

    const head = await resolveBranchHead(
      service.repoUrl,
      service.branch,
      repoToken(service.id),
    ).catch(() => null);

    // Unreadable is not the same as unchanged. Recording a failure as the current
    // state would mean the next successful read looked like a push that never
    // happened, and would build whatever was already there.
    if (!head) continue;
    if (head === service.lastPushedSha) continue;

    // Also skipped when this commit is already the one running.
    //
    // The build clones the branch rather than this exact commit, because asking a
    // git server for one loose object by name is a thing GitHub allows and plenty of
    // others do not. So a push landing in the seconds between reading the branch and
    // cloning it gets built as part of this deploy, and would otherwise be found
    // again on the next pass and built a second time, identically.
    if (head === runningDeployment(service.id)?.commitSha) {
      updateService(service.id, { lastPushedSha: head });
      continue;
    }

    const first = service.lastPushedSha === null;
    // Written down before the build, not after. If this only happened on success, a
    // commit that fails to build would be found again two minutes later, and again,
    // and the queue would never empty.
    updateService(service.id, { lastPushedSha: head });

    if (first) {
      done.push({
        serviceId: service.id,
        serviceName: service.name,
        sha: head,
        deployed: false,
      });
      continue;
    }

    // No ref: the branch is what gets cloned, and the deploy records whichever
    // commit that turned out to be.
    queueDeployment(service.id, 'push');
    publish('system', {
      type: 'notice',
      level: 'info',
      message: `${service.name}: deploying ${shortSha(head)}, just pushed to ${service.branch}.`,
    });
    done.push({ serviceId: service.id, serviceName: service.name, sha: head, deployed: true });
  }

  return done;
}

/**
 * Notes where a branch is without deploying it, when the setting is switched on.
 *
 * The watcher would do this on its next pass anyway, but two minutes of "following
 * this branch" with nothing to show is indistinguishable from a setting that did not
 * save.
 */
export async function adoptCurrentCommit(serviceId: string): Promise<string | null> {
  const service = listServices().find((entry) => entry.id === serviceId);
  if (!service?.repoUrl || !service.branch) return null;
  if (service.lastPushedSha) return service.lastPushedSha;

  const head = await resolveBranchHead(service.repoUrl, service.branch, repoToken(serviceId)).catch(
    () => null,
  );
  if (!head) return null;
  updateService(serviceId, { lastPushedSha: head });
  return head;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPushWatcher(): void {
  if (timer) return;
  timer = setInterval(() => void checkPushes().catch(() => undefined), INTERVAL_MS);
  timer.unref?.();
  // Not on boot, for the same reason as releases: a restart happens for reasons that
  // have nothing to do with anybody pushing anything, and it should not be a deploy.
}

export function stopPushWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
