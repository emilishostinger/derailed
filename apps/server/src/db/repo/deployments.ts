import type { Deployment, DeploymentStatus, DeploymentTrigger } from '@derailed/shared';
import { ACTIVE_DEPLOYMENT_STATUSES } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

interface DeploymentRow {
  id: string;
  service_id: string;
  status: DeploymentStatus;
  commit_sha: string | null;
  commit_message: string | null;
  trigger: DeploymentTrigger;
  image_tag: string | null;
  container_id: string | null;
  error_summary: string | null;
  error_hint: string | null;
  log_path: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const toDeployment = (row: DeploymentRow): Deployment => ({
  id: row.id,
  serviceId: row.service_id,
  status: row.status,
  commitSha: row.commit_sha,
  commitMessage: row.commit_message,
  trigger: row.trigger,
  imageTag: row.image_tag,
  containerId: row.container_id,
  errorSummary: row.error_summary,
  errorHint: row.error_hint,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export function createDeployment(
  serviceId: string,
  trigger: DeploymentTrigger = 'manual',
): Deployment {
  const id = newId();
  db()
    .query(
      `INSERT INTO deployments (id, service_id, status, trigger, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
    .run(id, serviceId, trigger, Date.now());
  return findDeployment(id)!;
}

export function findDeployment(id: string): Deployment | null {
  const row = db().query<DeploymentRow, [string]>('SELECT * FROM deployments WHERE id = ?').get(id);
  return row ? toDeployment(row) : null;
}

export function listDeployments(serviceId: string, limit = 30): Deployment[] {
  return db()
    .query<DeploymentRow, [string, number]>(
      'SELECT * FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(serviceId, limit)
    .map(toDeployment);
}

export function latestDeployment(serviceId: string): Deployment | null {
  const row = db()
    .query<DeploymentRow, [string]>(
      'SELECT * FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(serviceId);
  return row ? toDeployment(row) : null;
}

/** The deployment whose container should currently be serving traffic. */
export function runningDeployment(serviceId: string): Deployment | null {
  const row = db()
    .query<DeploymentRow, [string]>(
      `SELECT * FROM deployments WHERE service_id = ? AND status = 'running'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(serviceId);
  return row ? toDeployment(row) : null;
}

export function allRunningDeployments(): Deployment[] {
  return db()
    .query<DeploymentRow, []>(
      `SELECT d.* FROM deployments d
       JOIN (SELECT service_id, MAX(created_at) AS latest FROM deployments
             WHERE status = 'running' GROUP BY service_id) newest
         ON d.service_id = newest.service_id AND d.created_at = newest.latest
       WHERE d.status = 'running'`,
    )
    .all()
    .map(toDeployment);
}

export function activeDeployments(serviceId?: string): Deployment[] {
  const placeholders = ACTIVE_DEPLOYMENT_STATUSES.map(() => '?').join(', ');
  const statuses = [...ACTIVE_DEPLOYMENT_STATUSES];
  if (serviceId) {
    return db()
      .query<DeploymentRow, string[]>(
        `SELECT * FROM deployments WHERE service_id = ? AND status IN (${placeholders})
         ORDER BY created_at`,
      )
      .all(serviceId, ...statuses)
      .map(toDeployment);
  }
  return db()
    .query<DeploymentRow, string[]>(
      `SELECT * FROM deployments WHERE status IN (${placeholders}) ORDER BY created_at`,
    )
    .all(...statuses)
    .map(toDeployment);
}

export interface DeploymentPatch {
  status?: DeploymentStatus;
  commitSha?: string | null;
  commitMessage?: string | null;
  imageTag?: string | null;
  containerId?: string | null;
  errorSummary?: string | null;
  errorHint?: string | null;
  logPath?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

const COLUMNS: Record<keyof DeploymentPatch, string> = {
  status: 'status',
  commitSha: 'commit_sha',
  commitMessage: 'commit_message',
  imageTag: 'image_tag',
  containerId: 'container_id',
  errorSummary: 'error_summary',
  errorHint: 'error_hint',
  logPath: 'log_path',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

export function updateDeployment(id: string, patch: DeploymentPatch): Deployment | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(COLUMNS) as [keyof DeploymentPatch, string][]) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (!assignments.length) return findDeployment(id);
  db()
    .query(`UPDATE deployments SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return findDeployment(id);
}

/** Older successful deployments stay around for rollback but stop being "the" one. */
export function supersedePrevious(serviceId: string, keepDeploymentId: string): string[] {
  const rows = db()
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM deployments WHERE service_id = ? AND id != ? AND status = 'running'`,
    )
    .all(serviceId, keepDeploymentId);
  for (const row of rows) {
    db().query(`UPDATE deployments SET status = 'superseded' WHERE id = ?`).run(row.id);
  }
  return rows.map((row) => row.id);
}

export function deleteDeployment(id: string): void {
  db().query('DELETE FROM deployments WHERE id = ?').run(id);
}

export function deploymentsToPrune(serviceId: string, keep: number): Deployment[] {
  return db()
    .query<DeploymentRow, [string, number]>(
      'SELECT * FROM deployments WHERE service_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?',
    )
    .all(serviceId, keep)
    .map(toDeployment);
}
