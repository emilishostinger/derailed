import type { AppUpdate, AppUpdateStatus } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

/**
 * The record of every backup-first update: what was running, what replaced it, and
 * the copy taken before anything was touched. The row is the "put it back" button's
 * memory, so it is written before the update starts rather than after it went wrong.
 */

interface AppUpdateRow {
  id: string;
  service_id: string;
  status: AppUpdateStatus;
  trigger: 'manual' | 'auto';
  backup_id: string | null;
  from_ref: string | null;
  to_ref: string | null;
  message: string | null;
  created_at: number;
  finished_at: number | null;
}

function toAppUpdate(row: AppUpdateRow): AppUpdate {
  return {
    id: row.id,
    serviceId: row.service_id,
    status: row.status,
    trigger: row.trigger,
    backupId: row.backup_id,
    fromRef: row.from_ref,
    toRef: row.to_ref,
    message: row.message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function createAppUpdate(
  serviceId: string,
  trigger: 'manual' | 'auto',
  fromRef: string | null,
): AppUpdate {
  const id = newId();
  db()
    .query(
      `INSERT INTO app_updates (id, service_id, status, trigger, from_ref, created_at)
       VALUES (?, ?, 'backing-up', ?, ?, ?)`,
    )
    .run(id, serviceId, trigger, fromRef, Date.now());
  return findAppUpdate(id)!;
}

export function findAppUpdate(id: string): AppUpdate | null {
  const row = db().query<AppUpdateRow, [string]>('SELECT * FROM app_updates WHERE id = ?').get(id);
  return row ? toAppUpdate(row) : null;
}

export function updateAppUpdate(
  id: string,
  patch: Partial<{
    status: AppUpdateStatus;
    backupId: string | null;
    toRef: string | null;
    message: string | null;
    finishedAt: number | null;
  }>,
): AppUpdate | null {
  const columns: Record<string, string> = {
    status: 'status',
    backupId: 'backup_id',
    toRef: 'to_ref',
    message: 'message',
    finishedAt: 'finished_at',
  };
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, string | number | null | undefined>)[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length) {
    db()
      .query(`UPDATE app_updates SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, id);
  }
  return findAppUpdate(id);
}

export function listAppUpdates(serviceId: string, limit = 20): AppUpdate[] {
  return db()
    .query<AppUpdateRow, [string, number]>(
      'SELECT * FROM app_updates WHERE service_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(serviceId, limit)
    .map(toAppUpdate);
}

/** The newest update that knows the way back, for the "put it back" button. */
export function latestRevertibleUpdate(serviceId: string): AppUpdate | null {
  const row = db()
    .query<AppUpdateRow, [string]>(
      `SELECT * FROM app_updates
       WHERE service_id = ? AND from_ref IS NOT NULL AND status IN ('ok', 'failed')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(serviceId);
  return row ? toAppUpdate(row) : null;
}
