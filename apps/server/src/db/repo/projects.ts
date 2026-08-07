import type { Project } from '@derailed/shared';
import { newId, slugify, uniqueSlug } from '../../util/ids.ts';
import { db } from '../index.ts';
import { releaseDomainsFor } from './domains.ts';
import { listServices, listServicesEvenIfDeleted } from './services.ts';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  created_at: number;
  backup_schedule?: string | null;
  memory_limit_mb?: number | null;
  cpu_limit_millis?: number | null;
  deleted_at?: number | null;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  memoryLimitMb: row.memory_limit_mb ?? null,
  cpuLimitMillis: row.cpu_limit_millis ?? null,
  createdAt: row.created_at,
  backupSchedule:
    row.backup_schedule === 'daily' || row.backup_schedule === 'weekly'
      ? row.backup_schedule
      : 'off',
  deletedAt: row.deleted_at ?? null,
});

export function setProjectBackupSchedule(id: string, schedule: string): Project | null {
  db().query('UPDATE projects SET backup_schedule = ? WHERE id = ?').run(schedule, id);
  return findProject(id);
}

/**
 * The ceiling for everything in this project.
 *
 * Null means no limit, which is the default and stays the default: a cap somebody did
 * not ask for is a container killed for a reason nobody can find.
 */
export function setProjectLimits(
  id: string,
  limits: { memoryLimitMb?: number | null; cpuLimitMillis?: number | null },
): Project | null {
  const assignments: string[] = [];
  const values: (number | null)[] = [];

  if (limits.memoryLimitMb !== undefined) {
    assignments.push('memory_limit_mb = ?');
    values.push(limits.memoryLimitMb);
  }
  if (limits.cpuLimitMillis !== undefined) {
    assignments.push('cpu_limit_millis = ?');
    values.push(limits.cpuLimitMillis);
  }
  if (!assignments.length) return findProject(id);

  db()
    .query(`UPDATE projects SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return findProject(id);
}

/**
 * Everything that has not been deleted.
 *
 * A deleted project keeps its row for a week so it can be put back, which means
 * every read has to say whether it wants those. The default is no, in every case,
 * because a deleted project appearing in a list is a bug and a deleted one missing
 * from the trash is a smaller one.
 */
export function listProjects(): Project[] {
  return db()
    .query<ProjectRow, []>('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at')
    .all()
    .map(toProject);
}

/** Every project, deleted or not. Used where "does this still belong to us" is asked. */
export function listProjectsEvenIfDeleted(): Project[] {
  return db()
    .query<ProjectRow, []>('SELECT * FROM projects ORDER BY created_at')
    .all()
    .map(toProject);
}

/** Deleted, still recoverable, newest first: what the trash shows. */
export function listDeletedProjects(): Project[] {
  return db()
    .query<ProjectRow, []>(
      'SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    )
    .all()
    .map(toProject);
}

export function findProject(id: string): Project | null {
  const row = db()
    .query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(id);
  return row ? toProject(row) : null;
}

/** Including deleted ones. Only the trash, and restoring, have any business here. */
export function findProjectEvenIfDeleted(id: string): Project | null {
  const row = db().query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? toProject(row) : null;
}

export function findProjectBySlug(slug: string): Project | null {
  const row = db()
    .query<ProjectRow, [string]>('SELECT * FROM projects WHERE slug = ? AND deleted_at IS NULL')
    .get(slug);
  return row ? toProject(row) : null;
}

export function createProject(name: string): Project {
  // Deleted projects still hold their slug, and the column is still UNIQUE, so a new
  // project named after one in the trash has to pick a different slug rather than
  // fail on a constraint nobody could have predicted.
  const slug = uniqueSlug(
    slugify(name, 'project'),
    (candidate) =>
      !!db()
        .query<{ id: string }, [string]>('SELECT id FROM projects WHERE slug = ?')
        .get(candidate),
  );
  const project: ProjectRow = { id: newId(), name, slug, created_at: Date.now() };
  db()
    .query('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(project.id, project.name, project.slug, project.created_at);
  return toProject(project);
}

export function renameProject(id: string, name: string): Project | null {
  db().query('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
  return findProject(id);
}

/**
 * Marks a project deleted without losing anything.
 *
 * The apps inside are marked too, so nothing anywhere has to remember to ask about
 * the parent. Domains are released either way: a name pointing at something that is
 * no longer served would answer with the fallback 404, and leaving it attached would
 * stop it being used elsewhere in the meantime.
 */
export function softDeleteProject(id: string, at = Date.now()): void {
  for (const service of listServices(id)) releaseDomainsFor(service.id);
  db().query('UPDATE projects SET deleted_at = ? WHERE id = ?').run(at, id);
  db()
    .query('UPDATE services SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL')
    .run(at, id);
}

/**
 * Puts it back.
 *
 * Only the services that went down with the project are restored, hence matching on
 * the same timestamp: an app deleted on its own last Tuesday should stay deleted when
 * the project it happened to live in is restored today.
 */
export function restoreProject(id: string): void {
  const project = findProjectEvenIfDeleted(id);
  if (!project?.deletedAt) return;
  db()
    .query('UPDATE services SET deleted_at = NULL WHERE project_id = ? AND deleted_at = ?')
    .run(id, project.deletedAt);
  db().query('UPDATE projects SET deleted_at = NULL WHERE id = ?').run(id);
}

/** For real, and for ever. Only the trash sweep and "delete now" call this. */
export function deleteProject(id: string): void {
  // The generated addresses of every app inside go with it; domains you own do not.
  for (const service of listServicesEvenIfDeleted(id)) releaseDomainsFor(service.id);
  db().query('DELETE FROM projects WHERE id = ?').run(id);
}
