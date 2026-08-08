import type { ImportPlan, Service } from '@derailed/shared';
import { FriendlyError } from '../build/git.ts';
import { queueDeployment } from '../build/pipeline.ts';
import { replaceUserEnv } from '../db/repo/env.ts';
import { findProject } from '../db/repo/projects.ts';
import { createAppService, updateService } from '../db/repo/services.ts';
import { createVolume, pathInUse } from '../db/repo/volumes.ts';
import { emitProject } from '../runtime/present.ts';
import { startOrder } from './compose.ts';

/**
 * Turns an inspected plan into real services: created in dependency order,
 * wired with their variables and storage, and deployed in the same order, so a
 * database written above an app in the file is running before the app first
 * asks for it.
 */

export interface ImportResult {
  services: Service[];
  warnings: string[];
}

/** The folders no volume may sit over; same rule as the storage screen. */
const FORBIDDEN_MOUNTS = new Set(['/', '/etc', '/usr', '/bin', '/lib', '/sbin', '/var', '/opt']);

export async function applyImportPlan(projectId: string, plan: ImportPlan): Promise<ImportResult> {
  const project = findProject(projectId);
  if (!project) throw new FriendlyError("That project doesn't exist.");

  const ordered = startOrder(plan.services);
  const warnings: string[] = [];
  const created: Service[] = [];

  for (const entry of ordered) {
    const fromRepo = entry.source === 'repo';
    const service = createAppService({
      projectId,
      name: entry.name,
      source: entry.source,
      image: entry.image,
      command: entry.command,
      repoUrl: fromRepo ? plan.repoUrl : null,
      branch: fromRepo ? (plan.branch ?? 'main') : null,
      rootDir: fromRepo ? entry.rootDir : null,
      dockerfilePath: fromRepo ? entry.dockerfilePath : null,
      buildStrategy: fromRepo && entry.dockerfilePath ? 'dockerfile' : 'auto',
      port: entry.port,
      alias: entry.name,
      // No web port means no HTTP to wait for: the container staying up is the
      // health check, and no generated address points at something that can never
      // answer it. This covers the Redis, the worker, and the app that only its
      // compose neighbour (an nginx in the same file, say) is supposed to reach.
      healthCheck: entry.port === null ? 'started' : 'http',
    });
    created.push(service);

    if (entry.env.length) replaceUserEnv(service.id, entry.env);
    if (entry.memoryLimitMb) updateService(service.id, { memoryLimitMb: entry.memoryLimitMb });

    for (const path of entry.volumes) {
      if (FORBIDDEN_MOUNTS.has(path.replace(/\/+$/, '') || '/')) {
        warnings.push(
          `"${entry.name}" wanted storage over ${path}, which would break the container. Skipped.`,
        );
        continue;
      }
      if (!pathInUse(service.id, path)) createVolume(service.id, path);
    }
  }

  // Deployed in the same order they were created: dependencies first. The queue
  // starts builds in the order they were queued, which is as close to compose's
  // start order as a build queue honestly gets.
  for (const service of created) {
    queueDeployment(service.id, 'manual');
  }

  emitProject(projectId);
  return { services: created, warnings };
}
