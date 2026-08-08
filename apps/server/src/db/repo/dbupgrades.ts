import type { DbUpgrade, DbUpgradeStatus } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

/**
 * The record of every major-version move. The row is written before anything is
 * touched and carries the names of what is being kept: the stopped old container
 * and its volume, so the cleanup a week later removes those and nothing else.
 */

interface DbUpgradeRow {
  id: string;
  service_id: string;
  from_version: string;
  to_version: string;
  snapshot_id: string | null;
  old_container: string | null;
  old_volume: string | null;
  status: DbUpgradeStatus;
  message: string | null;
  created_at: number;
  finished_at: number | null;
  cleanup_after: number | null;
  cleaned_at: number | null;
}

function toDbUpgrade(row: DbUpgradeRow): DbUpgrade {
  return {
    id: row.id,
    serviceId: row.service_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    snapshotId: row.snapshot_id,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    cleanupAfter: row.cleanup_after,
    cleanedAt: row.cleaned_at,
  };
}

export function createDbUpgrade(serviceId: string, from: string, to: string): DbUpgrade {
  const id = newId();
  db()
    .query(
      `INSERT INTO db_upgrades (id, service_id, from_version, to_version, status, created_at)
       VALUES (?, ?, ?, ?, 'copying', ?)`,
    )
    .run(id, serviceId, from, to, Date.now());
  return findDbUpgrade(id)!;
}

export function findDbUpgrade(id: string): DbUpgrade | null {
  const row = db().query<DbUpgradeRow, [string]>('SELECT * FROM db_upgrades WHERE id = ?').get(id);
  return row ? toDbUpgrade(row) : null;
}

export function updateDbUpgrade(
  id: string,
  patch: Partial<{
    status: DbUpgradeStatus;
    snapshotId: string | null;
    oldContainer: string | null;
    oldVolume: string | null;
    message: string | null;
    finishedAt: number | null;
    cleanupAfter: number | null;
    cleanedAt: number | null;
  }>,
): DbUpgrade | null {
  const columns: Record<string, string> = {
    status: 'status',
    snapshotId: 'snapshot_id',
    oldContainer: 'old_container',
    oldVolume: 'old_volume',
    message: 'message',
    finishedAt: 'finished_at',
    cleanupAfter: 'cleanup_after',
    cleanedAt: 'cleaned_at',
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
      .query(`UPDATE db_upgrades SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, id);
  }
  return findDbUpgrade(id);
}

export function listDbUpgrades(serviceId: string, limit = 20): DbUpgrade[] {
  return db()
    .query<DbUpgradeRow, [string, number]>(
      'SELECT * FROM db_upgrades WHERE service_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(serviceId, limit)
    .map(toDbUpgrade);
}

/** Whatever is kept and now due to be tidied away, across every database. */
export function upgradesDueCleanup(now = Date.now()): (DbUpgrade & {
  oldContainer: string | null;
  oldVolume: string | null;
})[] {
  return db()
    .query<DbUpgradeRow, [number]>(
      `SELECT * FROM db_upgrades
       WHERE status = 'ok' AND cleaned_at IS NULL
         AND cleanup_after IS NOT NULL AND cleanup_after <= ?`,
    )
    .all(now)
    .map((row) => ({
      ...toDbUpgrade(row),
      oldContainer: row.old_container,
      oldVolume: row.old_volume,
    }));
}
