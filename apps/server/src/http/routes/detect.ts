import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { detectRepo } from '../../build/detect.ts';
import {
  cloneRepo,
  FriendlyError,
  normalizeRepoUrl,
  resolveDefaultBranch,
  suggestedNameFromRepo,
} from '../../build/git.ts';
import { paths } from '../../config.ts';
import { shortId } from '../../util/ids.ts';
import type { AppEnv } from '../auth.ts';
import { ApiError, parseBody } from '../errors.ts';

export const detectRoutes = new Hono<AppEnv>();

/**
 * The wizard's "magic" step: clone the repo shallowly, look at it, throw the copy
 * away, and answer in plain language. Kept deliberately fast, one shallow clone.
 */
detectRoutes.post('/', async (c) => {
  const body = await parseBody(c, schemas.detectRequest);

  let repo: ReturnType<typeof normalizeRepoUrl>;
  try {
    repo = normalizeRepoUrl(body.repoUrl);
  } catch (err) {
    if (err instanceof FriendlyError) throw new ApiError(400, 'bad_repo', err.message, err.hint);
    throw err;
  }

  const branch = body.branch?.trim() || (await resolveDefaultBranch(repo.url));
  const workdir = join(paths.builds, `detect-${shortId()}`);

  try {
    const clone = await cloneRepo(repo.url, branch, workdir);
    const result = await detectRepo({ dir: workdir, rootDir: body.rootDir });
    return c.json({
      detect: {
        ...result,
        suggestedName: result.suggestedName || suggestedNameFromRepo(repo),
      },
      repo: { url: repo.url, path: repo.path, branch: clone.branch },
      commit: { sha: clone.commitSha, message: clone.commitMessage },
    });
  } catch (err) {
    if (err instanceof FriendlyError) throw new ApiError(400, 'repo_error', err.message, err.hint);
    throw err;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
});
