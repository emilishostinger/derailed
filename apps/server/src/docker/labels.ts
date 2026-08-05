/**
 * Every Docker object Derailed creates is labelled. Reconciliation, cleanup and
 * "what is this container?" all key off these. We never touch anything unlabelled,
 * so an unrelated container on the same host is always safe.
 */
export const LABELS = {
  managed: 'derailed.managed',
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
