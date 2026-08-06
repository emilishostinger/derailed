import type { DeployDiff, Deployment } from '@derailed/shared';
import { findDeployment, listDeployments } from '../db/repo/deployments.ts';

/**
 * What changed between two deploys.
 *
 * Debugging is mostly bisecting what changed, and Derailed knew and did not say. It
 * has the commits, it has the variables, it has the image, and every one of those is
 * the answer to "it worked yesterday".
 *
 * Variable *values* are never included, only which ones moved. A diff that printed a
 * database password into a page somebody screenshots for help would be the worst kind
 * of helpful.
 */

/** The deploy before this one that actually shipped, which is what "before" means. */
function previousShipped(deployment: Deployment): Deployment | null {
  const history = listDeployments(deployment.serviceId, 100);
  const index = history.findIndex((entry) => entry.id === deployment.id);
  if (index < 0) return null;

  return (
    history
      .slice(index + 1)
      .find((entry) => entry.status === 'running' || entry.status === 'superseded') ?? null
  );
}

/**
 * The commits between two deploys, taken from the deploys themselves.
 *
 * Deliberately not `git log`. The checkout a build happened in is deleted the moment
 * it finishes, so there is no repository on this machine to ask, and cloning one to
 * answer "what changed" would be a network round trip and a few hundred megabytes for
 * a list. Every deploy already records the commit it was built from, so walking the
 * history between two of them gives the same answer from data that is already here.
 *
 * It misses commits that were never deployed, which is the right trade: this question
 * is asked about what actually ran.
 */
function commitsBetween(
  deployment: Deployment,
  previous: Deployment | null,
): {
  sha: string;
  message: string;
}[] {
  const history = listDeployments(deployment.serviceId, 200);
  const from = history.findIndex((entry) => entry.id === deployment.id);
  const to = previous ? history.findIndex((entry) => entry.id === previous.id) : history.length;
  if (from < 0) return [];

  return history
    .slice(from, to < 0 ? undefined : to)
    .filter((entry) => entry.commitSha)
    .map((entry) => ({
      sha: entry.commitSha!,
      message: entry.commitMessage ?? 'no message',
    }));
}

/** Which variables moved. Values are compared but never returned. */
function envChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): DeployDiff['envChanged'] {
  const changes: DeployDiff['envChanged'] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of [...keys].sort()) {
    const had = key in before;
    const has = key in after;
    if (had && !has) changes.push({ key, change: 'removed' });
    else if (!had && has) changes.push({ key, change: 'added' });
    else if (before[key] !== after[key]) changes.push({ key, change: 'changed' });
  }
  return changes;
}

/**
 * What changed, in words.
 *
 * Attached to a failure automatically, because "this worked yesterday, and since then
 * three commits landed and NODE_ENV changed" is most of a diagnosis on its own.
 */
export function diffDeploys(
  deploymentId: string,
  envBefore?: Record<string, string>,
  envAfter?: Record<string, string>,
): DeployDiff | null {
  const deployment = findDeployment(deploymentId);
  if (!deployment) return null;

  const previous = previousShipped(deployment);

  const commits = commitsBetween(deployment, previous);

  const envChanged = envBefore && envAfter ? envChanges(envBefore, envAfter) : [];
  const imageChanged = !!previous && previous.imageTag !== deployment.imageTag;

  return {
    from: previous
      ? {
          id: previous.id,
          at: previous.finishedAt ?? previous.createdAt,
          commitSha: previous.commitSha,
        }
      : null,
    to: {
      id: deployment.id,
      at: deployment.finishedAt ?? deployment.createdAt,
      commitSha: deployment.commitSha,
    },
    commits,
    envChanged,
    imageChanged,
    summary: summarise(previous, commits, envChanged),
  };
}

function summarise(
  previous: Deployment | null,
  commits: { sha: string }[],
  envChanged: DeployDiff['envChanged'],
): string {
  if (!previous) return 'This is the first version of this app that has run.';

  const parts: string[] = [];
  if (commits.length) {
    parts.push(`${commits.length} commit${commits.length === 1 ? '' : 's'}`);
  }
  if (envChanged.length) {
    parts.push(
      `${envChanged.length} variable${envChanged.length === 1 ? '' : 's'} changed (${envChanged
        .slice(0, 3)
        .map((entry) => entry.key)
        .join(', ')}${envChanged.length > 3 ? ', and more' : ''})`,
    );
  }

  if (!parts.length) return 'Nothing changed between these two, beyond a rebuild.';
  return `Since the version before this one: ${parts.join(', and ')}.`;
}
