import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { detectRepo, safeJoin } from '../../build/detect.ts';
import {
  cloneRepo,
  FriendlyError,
  normalizeRepoUrl,
  resolveDefaultBranch,
  suggestedNameFromRepo,
} from '../../build/git.ts';
import { nixpacksPlan, providerLabel } from '../../build/nixpacks.ts';
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

    // When our own tables drew a blank, ask the builder itself before shrugging:
    // Nixpacks knows more languages than the rules above. Bounded so a slow first
    // binary download can't hold the wizard hostage; the answer is a nicety.
    if (result.strategy === 'nixpacks' && !result.framework && !result.suggestedRootDir) {
      const plan = await Promise.race([
        nixpacksPlan(safeJoin(workdir, body.rootDir)).catch(() => null),
        Bun.sleep(20_000).then(() => null),
      ]);
      const provider = plan?.providers?.[0];
      if (provider) {
        const label = providerLabel(provider);
        result.framework = label;
        result.summary = `The builder recognises this as ${label}. I'll build it that way, and the app's settings can override it if that's wrong.`;
      }
    }

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
