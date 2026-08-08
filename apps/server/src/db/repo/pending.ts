import type { EnvHistoryEntry, PendingChange, PendingChangeKind } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';
import { findService } from './services.ts';

/**
 * What will change.
 *
 * With a project's review switch on, edits to variables, settings and domains stop
 * landing one by one and collect here instead: "3 changes waiting, apply together?"
 * with a diff a person can read. One honest screen between editing and production.
 *
 * The payload is the request that would have run, kept verbatim; the summary and
 * diff are written at staging time because that is when the "before" they describe
 * was true. Values of variables appear in neither, ever: which keys moved is the
 * story, and the values are secrets.
 */

interface PendingRow {
  id: string;
  project_id: string;
  service_id: string | null;
  kind: PendingChangeKind;
  payload: string;
  summary: string;
  diff: string;
  created_at: number;
  created_by: string | null;
}

const toChange = (row: PendingRow): PendingChange & { payload: unknown } => ({
  id: row.id,
  projectId: row.project_id,
  serviceId: row.service_id,
  serviceName: row.service_id ? (findService(row.service_id)?.name ?? null) : null,
  kind: row.kind,
  summary: row.summary,
  diff: JSON.parse(row.diff) as string[],
  createdAt: row.created_at,
  createdBy: row.created_by,
  payload: JSON.parse(row.payload) as unknown,
});

export function stageChange(input: {
  projectId: string;
  serviceId: string | null;
  kind: PendingChangeKind;
  payload: unknown;
  summary: string;
  diff: string[];
  by: string | null;
}): PendingChange {
  const id = newId();
  // One waiting edit per thing being edited: saving the variables twice while the
  // first save waits must replace the first, or applying would run both and the
  // older one would win nothing but confusion.
  db()
    .query(
      `DELETE FROM pending_changes
       WHERE project_id = ? AND kind = ? AND COALESCE(service_id, '') = COALESCE(?, '')
         AND kind IN ('env', 'project-env', 'setting')`,
    )
    .run(input.projectId, input.kind, input.serviceId);
  db()
    .query(
      `INSERT INTO pending_changes
        (id, project_id, service_id, kind, payload, summary, diff, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.serviceId,
      input.kind,
      JSON.stringify(input.payload),
      input.summary,
      JSON.stringify(input.diff),
      Date.now(),
      input.by,
    );
  return listPending(input.projectId).find((change) => change.id === id)!;
}

export function listPending(projectId: string): (PendingChange & { payload: unknown })[] {
  return db()
    .query<PendingRow, [string]>(
      'SELECT * FROM pending_changes WHERE project_id = ? ORDER BY created_at',
    )
    .all(projectId)
    .map(toChange);
}

export function countPending(projectId: string): number {
  return (
    db()
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM pending_changes WHERE project_id = ?',
      )
      .get(projectId)?.n ?? 0
  );
}

export function discardPending(projectId: string, changeId?: string): void {
  if (changeId) {
    db()
      .query('DELETE FROM pending_changes WHERE project_id = ? AND id = ?')
      .run(projectId, changeId);
  } else {
    db().query('DELETE FROM pending_changes WHERE project_id = ?').run(projectId);
  }
}

/** The key-level story of one env save: which keys appeared, went, or moved. */
export function envDiff(
  before: { key: string; value: string }[],
  after: { key: string; value: string }[],
): { key: string; change: 'added' | 'removed' | 'changed' }[] {
  const was = new Map(before.map((entry) => [entry.key, entry.value]));
  const is = new Map(after.map((entry) => [entry.key, entry.value]));
  const out: { key: string; change: 'added' | 'removed' | 'changed' }[] = [];
  for (const [key, value] of is) {
    if (!was.has(key)) out.push({ key, change: 'added' });
    else if (was.get(key) !== value) out.push({ key, change: 'changed' });
  }
  for (const key of was.keys()) {
    if (!is.has(key)) out.push({ key, change: 'removed' });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The diff, phrased for the review screen. Keys only, never values. */
export function envDiffLines(diff: { key: string; change: string }[]): string[] {
  return diff.map((entry) => `${entry.key} ${entry.change}`);
}

export function recordEnvHistory(
  scope: { serviceId?: string | null; projectId?: string | null },
  changes: { key: string; change: 'added' | 'removed' | 'changed' }[],
  by: string | null,
): void {
  if (changes.length === 0) return;
  db()
    .query(
      'INSERT INTO env_history (id, service_id, project_id, at, by, changes) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      newId(),
      scope.serviceId ?? null,
      scope.projectId ?? null,
      Date.now(),
      by,
      JSON.stringify(changes),
    );
}

interface HistoryRow {
  id: string;
  at: number;
  by: string | null;
  changes: string;
}

const KEEP_HISTORY = 100;

export function envHistoryFor(scope: {
  serviceId?: string;
  projectId?: string;
}): EnvHistoryEntry[] {
  const rows = scope.serviceId
    ? db()
        .query<HistoryRow, [string, number]>(
          'SELECT * FROM env_history WHERE service_id = ? ORDER BY at DESC LIMIT ?',
        )
        .all(scope.serviceId, KEEP_HISTORY)
    : db()
        .query<HistoryRow, [string, number]>(
          'SELECT * FROM env_history WHERE project_id = ? AND service_id IS NULL ORDER BY at DESC LIMIT ?',
        )
        .all(scope.projectId ?? '', KEEP_HISTORY);
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    by: row.by,
    changes: JSON.parse(row.changes) as EnvHistoryEntry['changes'],
  }));
}
