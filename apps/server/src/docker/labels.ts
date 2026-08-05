import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';

/**
 * Every Docker object Derailed creates is labelled. Reconciliation, cleanup and
 * "what is this container?" all key off these. We never touch anything unlabelled,
 * so an unrelated container on the same host is always safe.
 */

let cachedInstall: string | null = null;

/**
 * A random id for this installation, kept beside the database.
 *
 * Without it, a second Derailed pointed at a different data folder sees containers it
 * has no record of and tidies them away as orphans. That is not hypothetical: running
 * one for ten seconds to smoke-test a build deleted four running apps belonging to the
 * real one on the same machine.
 */
export function installId(): string {
  if (cachedInstall) return cachedInstall;
  const file = join(paths.dataDir, 'install.id');
  if (existsSync(file)) {
    cachedInstall = readFileSync(file, 'utf8').trim();
    if (cachedInstall) return cachedInstall;
  }
  cachedInstall = randomBytes(8).toString('hex');
  try {
    writeFileSync(file, cachedInstall, { mode: 0o600 });
  } catch {
    // A read-only data dir is someone else's problem; an id that lasts for this
    // process is still enough to stop us deleting another installation's work.
  }
  return cachedInstall;
}
export const LABELS = {
  managed: 'derailed.managed',
  /** Which installation made this, so one Derailed never clears up after another. */
  install: 'derailed.install',
  project: 'derailed.project',
  service: 'derailed.service',
  deployment: 'derailed.deployment',
  role: 'derailed.role',
} as const;

export type ManagedRole = 'app' | 'database' | 'proxy' | 'build';

export interface LabelSpec {
  projectId?: string;
  serviceId?: string;
  deploymentId?: string;
  role: ManagedRole;
}

export function managedLabels(spec: LabelSpec): Record<string, string> {
  const labels: Record<string, string> = {
    [LABELS.managed]: 'true',
    [LABELS.install]: installId(),
    [LABELS.role]: spec.role,
  };
  if (spec.projectId) labels[LABELS.project] = spec.projectId;
  if (spec.serviceId) labels[LABELS.service] = spec.serviceId;
  if (spec.deploymentId) labels[LABELS.deployment] = spec.deploymentId;
  return labels;
}

export function isManaged(labels: Record<string, string> | undefined | null): boolean {
  return labels?.[LABELS.managed] === 'true';
}

/** Docker's `filters` query param is a JSON object of arrays. */
export function labelFilter(pairs: Record<string, string | undefined>): string {
  const label = Object.entries(pairs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return JSON.stringify({ label });
}

export const MANAGED_FILTER = labelFilter({ [LABELS.managed]: 'true' });
