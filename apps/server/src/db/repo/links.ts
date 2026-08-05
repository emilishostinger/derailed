import type { Link } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

interface LinkRow {
  id: string;
  project_id: string;
  from_service_id: string;
  to_service_id: string;
  inject_as: string | null;
  created_at: number;
}

const toLink = (row: LinkRow): Link => ({
  id: row.id,
  projectId: row.project_id,
  fromServiceId: row.from_service_id,
  toServiceId: row.to_service_id,
  injectAs: row.inject_as,
});

export function listLinks(projectId?: string): Link[] {
  const rows = projectId
    ? db().query<LinkRow, [string]>('SELECT * FROM links WHERE project_id = ?').all(projectId)
    : db().query<LinkRow, []>('SELECT * FROM links').all();
  return rows.map(toLink);
}

export function linksFrom(serviceId: string): Link[] {
  return db()
    .query<LinkRow, [string]>('SELECT * FROM links WHERE from_service_id = ?')
    .all(serviceId)
    .map(toLink);
}

export function linksTo(serviceId: string): Link[] {
  return db()
    .query<LinkRow, [string]>('SELECT * FROM links WHERE to_service_id = ?')
    .all(serviceId)
    .map(toLink);
}

export function findLink(id: string): Link | null {
  const row = db().query<LinkRow, [string]>('SELECT * FROM links WHERE id = ?').get(id);
  return row ? toLink(row) : null;
}

export function createLink(
  projectId: string,
  fromServiceId: string,
  toServiceId: string,
  injectAs: string | null,
): Link {
  const id = newId();
  db()
    .query(
      `INSERT INTO links (id, project_id, from_service_id, to_service_id, inject_as, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, fromServiceId, toServiceId, injectAs, Date.now());
  return findLink(id)!;
}

export function deleteLink(id: string): void {
  db().query('DELETE FROM links WHERE id = ?').run(id);
}
