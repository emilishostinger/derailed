import type { ImportPlan, Service } from '@derailed/shared';
import { FriendlyError } from '../build/git.ts';
import { queueDeployment } from '../build/pipeline.ts';
import { createDatabaseFromCatalog } from '../catalog/create.ts';
import { findEngine } from '../catalog/databases.ts';
import { connectServices } from '../catalog/links.ts';
import { replaceUserEnv } from '../db/repo/env.ts';
import { findProject } from '../db/repo/projects.ts';
import { createAppService, updateService } from '../db/repo/services.ts';
import { createVolume, pathInUse } from '../db/repo/volumes.ts';
import { createJob } from '../jobs/run.ts';
import { isValidCron } from '../jobs/schedule.ts';
import { emitProject } from '../runtime/present.ts';
import { randomSecret } from '../util/crypto.ts';
import { startOrder } from './compose.ts';

/**
 * Turns an inspected plan into real things, in the order they need each other:
 * databases first, then services in dependency order, then the wiring, then the
 * deploys, queued in the same order so what is depended on is running first.
 */

export interface ImportResult {
  services: Service[];
  databases: Service[];
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
  const databases: Service[] = [];
  const databaseByPlanName = new Map<string, Service>();

  // Databases first: they are what everything else is about to ask for.
  for (const entry of plan.databases ?? []) {
    const engine = findEngine(entry.engine);
    if (!engine) {
      warnings.push(`Derailed does not run "${entry.engine}", so ${entry.name} was skipped.`);
      continue;
    }
    const version = engine.versions.includes(entry.version) ? entry.version : engine.versions[0]!;
    if (version !== entry.version) {
      warnings.push(
        `${engine.label} ${entry.version} is not offered here; ${entry.name} was created on ${version}.`,
      );
    }
    const database = await createDatabaseFromCatalog(projectId, entry.name, engine.engine, version);
    databases.push(database);
    databaseByPlanName.set(entry.name, database);
  }

  // Which keys each service will have injected by a link, so a value that came
  // along in the plan does not collide with the injection that replaces it.
  const injectedKeys = new Map<string, Set<string>>();
  for (const entry of plan.databases ?? []) {
    const engine = findEngine(entry.engine);
    for (const link of entry.linkTo) {
      const keys = injectedKeys.get(link.service) ?? new Set<string>();
      keys.add(link.injectAs ?? engine?.defaultInjectKey ?? 'DATABASE_URL');
      injectedKeys.set(link.service, keys);
    }
  }

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
      healthCheck: entry.healthCheck,
      healthPath: entry.healthPath ?? undefined,
    });
    created.push(service);

    const taken = injectedKeys.get(entry.name) ?? new Set<string>();
    const env = entry.env
      .filter((variable) => !taken.has(variable.key))
      .map((variable) => ({
        key: variable.key,
        // The platform would have invented this value; Derailed invents one too.
        value: variable.generate ? randomSecret(24) : variable.value,
      }));
    if (env.length) replaceUserEnv(service.id, env);
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

  // The wiring: each database's address lands in the environment of everything
  // that asked for it, under the key it asked for.
  for (const entry of plan.databases ?? []) {
    const database = databaseByPlanName.get(entry.name);
    if (!database) continue;
    for (const link of entry.linkTo) {
      const app = created.find((candidate) => candidate.name === link.service);
      if (!app) continue;
      try {
        await connectServices(app.id, database.id, link.injectAs);
      } catch (err) {
        warnings.push(
          `Connecting ${link.service} to ${entry.name} did not work: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  for (const entry of plan.jobs ?? []) {
    const host = created.find((candidate) => candidate.name === entry.service);
    if (!host) {
      warnings.push(`The schedule "${entry.name}" has no app to run inside, so it was skipped.`);
      continue;
    }
    if (!isValidCron(entry.schedule)) {
      warnings.push(
        `The schedule "${entry.name}" (${entry.schedule}) is not five-field cron. Skipped.`,
      );
      continue;
    }
    createJob({
      serviceId: host.id,
      name: entry.name,
      command: entry.command,
      schedule: entry.schedule,
    });
  }

  // Deployed in the same order they were created: dependencies first. The queue
  // starts builds in the order they were queued, which is as close to a start
  // order as a build queue honestly gets.
  for (const service of created) {
    queueDeployment(service.id, 'manual');
  }

  emitProject(projectId);
  return { services: created, databases, warnings };
}
