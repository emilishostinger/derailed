import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportPlan } from '@derailed/shared';
import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { safeJoin } from '../../build/detect.ts';
import {
  cloneRepo,
  FriendlyError,
  normalizeRepoUrl,
  resolveDefaultBranch,
  suggestedNameFromRepo,
} from '../../build/git.ts';
import { paths } from '../../config.ts';
import { parseDotEnv } from '../../db/repo/env.ts';
import { findProject } from '../../db/repo/projects.ts';
import { applyImportPlan } from '../../import/apply.ts';
import { COMPOSE_FILENAMES, parseCompose } from '../../import/compose.ts';
import { shortId } from '../../util/ids.ts';
import type { AppEnv } from '../auth.ts';
import { ApiError, notFound, parseBody } from '../errors.ts';

/**
 * Point Derailed at a repository with a compose file and get a project of
 * ordinary services. Two steps on purpose: inspect answers with a plan and
 * creates nothing, so what is about to happen is on the screen before it does;
 * apply takes the plan back and builds it.
 */
export const importRoutes = new Hono<AppEnv>();
export const projectImportRoutes = new Hono<AppEnv>();

async function readInside(dir: string, relative: string): Promise<string | null> {
  try {
    const full = safeJoin(dir, relative);
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

importRoutes.post('/inspect', async (c) => {
  const body = await parseBody(c, schemas.importInspectRequest);

  let repo: ReturnType<typeof normalizeRepoUrl>;
  try {
    repo = normalizeRepoUrl(body.repoUrl);
  } catch (err) {
    if (err instanceof FriendlyError) throw new ApiError(400, 'bad_repo', err.message, err.hint);
    throw err;
  }

  const branch = body.branch?.trim() || (await resolveDefaultBranch(repo.url));
  const workdir = join(paths.builds, `import-${shortId()}`);

  try {
    const clone = await cloneRepo(repo.url, branch, workdir);
    const lookIn = body.rootDir?.trim() ? safeJoin(workdir, body.rootDir) : workdir;

    let composeText: string | null = null;
    let composeFile: string | null = null;
    for (const filename of COMPOSE_FILENAMES) {
      composeText = await readInside(lookIn, filename);
      if (composeText !== null) {
        composeFile = filename;
        break;
      }
    }
    if (composeText === null || !composeFile) {
      throw new FriendlyError(
        'There is no compose file in that repository.',
        `Derailed looked for ${COMPOSE_FILENAMES.join(', ')}${body.rootDir ? ` in ${body.rootDir}` : ''}.`,
      );
    }

    // The `.env` beside the file is how compose fills in ${VARIABLES}.
    const toRecord = (entries: { key: string; value: string }[]): Record<string, string> =>
      Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
    const dotEnv = await readInside(lookIn, '.env');
    const reading = parseCompose(composeText, {
      env: dotEnv ? toRecord(parseDotEnv(dotEnv)) : {},
      readEnvFile: (relative) => {
        // Synchronous by contract; the file was cloned a moment ago and is warm.
        try {
          return toRecord(parseDotEnv(readFileSync(safeJoin(lookIn, relative), 'utf8')));
        } catch {
          return null;
        }
      },
    });

    // Build contexts are relative to the compose file, which may itself sit in a
    // folder; a service's rootDir has to be relative to the repository root.
    if (body.rootDir?.trim()) {
      const prefix = body.rootDir
        .trim()
        .replace(/^\.\/?/, '')
        .replace(/\/+$/, '');
      for (const service of reading.services) {
        if (service.source === 'repo') {
          service.rootDir = service.rootDir ? `${prefix}/${service.rootDir}` : prefix;
        }
      }
    }

    const plan: ImportPlan = {
      source: 'compose',
      repoUrl: repo.url,
      branch: clone.branch ?? branch ?? null,
      services: reading.services,
      warnings: reading.warnings,
    };
    return c.json({
      plan,
      composeFile,
      suggestedName: suggestedNameFromRepo(repo),
    });
  } catch (err) {
    if (err instanceof FriendlyError)
      throw new ApiError(400, 'import_error', err.message, err.hint);
    throw err;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** POST /projects/:id/import */
projectImportRoutes.post('/:id/import', async (c) => {
  const project = findProject(c.req.param('id'));
  if (!project) throw notFound('That project');

  const body = await parseBody(c, schemas.applyImportPlanRequest);
  // The URL round-tripped through the browser; hold it to the same standard as
  // one typed in fresh.
  const repo = normalizeRepoUrl(body.plan.repoUrl);
  const result = await applyImportPlan(project.id, {
    ...body.plan,
    repoUrl: repo.url,
  } as ImportPlan);
  return c.json(
    {
      services: result.services,
      warnings: result.warnings,
    },
    201,
  );
});
