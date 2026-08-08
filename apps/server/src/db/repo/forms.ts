import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

/**
 * What people typed into a site's forms. One row per message, the fields as
 * JSON, kept until somebody deletes them. Deliberately plain: a contact form's
 * whole job is to still be readable in six months.
 */

export interface FormSubmission {
  id: string;
  serviceId: string;
  form: string;
  fields: Record<string, string>;
  ip: string | null;
  createdAt: number;
}

interface SubmissionRow {
  id: string;
  service_id: string;
  form: string;
  data: string;
  ip: string | null;
  created_at: number;
}

function toSubmission(row: SubmissionRow): FormSubmission {
  let fields: Record<string, string> = {};
  try {
    fields = JSON.parse(row.data) as Record<string, string>;
  } catch {
    // A row that cannot be read is still a row that arrived.
  }
  return {
    id: row.id,
    serviceId: row.service_id,
    form: row.form,
    fields,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

export function recordSubmission(
  serviceId: string,
  form: string,
  fields: Record<string, string>,
  ip: string | null,
): FormSubmission {
  const id = newId();
  db()
    .query(
      'INSERT INTO form_submissions (id, service_id, form, data, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, serviceId, form, JSON.stringify(fields), ip, Date.now());
  return findSubmission(id)!;
}

export function findSubmission(id: string): FormSubmission | null {
  const row = db()
    .query<SubmissionRow, [string]>('SELECT * FROM form_submissions WHERE id = ?')
    .get(id);
  return row ? toSubmission(row) : null;
}

export function listSubmissions(serviceId: string, limit = 100, offset = 0): FormSubmission[] {
  return db()
    .query<SubmissionRow, [string, number, number]>(
      'SELECT * FROM form_submissions WHERE service_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
    )
    .all(serviceId, limit, offset)
    .map(toSubmission);
}

export function countSubmissions(serviceId: string): number {
  return (
    db()
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM form_submissions WHERE service_id = ?',
      )
      .get(serviceId)?.n ?? 0
  );
}

export function deleteSubmission(serviceId: string, id: string): boolean {
  const found = findSubmission(id);
  if (!found || found.serviceId !== serviceId) return false;
  db().query('DELETE FROM form_submissions WHERE id = ?').run(id);
  return true;
}
