import type { SavedQuery } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

/**
 * Queries somebody wanted to keep.
 *
 * Kept against the database rather than against the person who wrote them. The useful
 * ones are facts about the shape of the data ("orders stuck in pending"), not personal
 * notes, and a second owner arriving should find them already there.
 */

interface QueryRow {
  id: string;
  service_id: string;
  name: string;
  body: string;
  created_at: number;
}

const toQuery = (row: QueryRow): SavedQuery => ({
  id: row.id,
  serviceId: row.service_id,
  name: row.name,
  body: row.body,
  createdAt: row.created_at,
});

export function listSavedQueries(serviceId: string): SavedQuery[] {
  return db()
    .query<QueryRow, [string]>(
      'SELECT * FROM saved_queries WHERE service_id = ? ORDER BY created_at',
    )
    .all(serviceId)
    .map(toQuery);
}

export function findSavedQuery(id: string): SavedQuery | null {
  const row = db().query<QueryRow, [string]>('SELECT * FROM saved_queries WHERE id = ?').get(id);
  return row ? toQuery(row) : null;
}

/**
 * Saving under a name that is already used replaces it.
 *
 * Somebody refining a query saves it four times while getting it right, and four
 * near-identical entries called "stuck orders" is worse than one that is current.
 */
export function saveQuery(serviceId: string, name: string, body: string): SavedQuery {
  const existing = listSavedQueries(serviceId).find((query) => query.name === name);
  if (existing) {
    db().query('UPDATE saved_queries SET body = ? WHERE id = ?').run(body, existing.id);
    return findSavedQuery(existing.id)!;
  }

  const id = newId();
  db()
    .query(
      'INSERT INTO saved_queries (id, service_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, serviceId, name, body, Date.now());
  return findSavedQuery(id)!;
}

export function deleteSavedQuery(id: string): void {
  db().query('DELETE FROM saved_queries WHERE id = ?').run(id);
}
