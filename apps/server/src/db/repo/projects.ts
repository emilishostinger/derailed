import type { Project } from '@derailed/shared';
import { newId, slugify, uniqueSlug } from '../../util/ids.ts';
import { db } from '../index.ts';
import { releaseDomainsFor } from './domains.ts';
import { listServices } from './services.ts';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  created_at: number;
  backup_schedule?: string | null;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  createdAt: row.created_at,
  backupSchedule:
    row.backup_schedule === 'daily' || row.backup_schedule === 'weekly'
      ? row.backup_schedule
      : 'off',
});

export function setProjectBackupSchedule(id: string, schedule: string): Project | null {
  db().query('UPDATE projects SET backup_schedule = ? WHERE id = ?').run(schedule, id);
  return findProject(id);
}

export function listProjects(): Project[] {
  return db()
    .query<ProjectRow, []>('SELECT * FROM projects ORDER BY created_at')
    .all()
    .map(toProject);
}

export function findProject(id: string): Project | null {
  const row = db().query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? toProject(row) : null;
}

export function findProjectBySlug(slug: string): Project | null {
  const row = db().query<ProjectRow, [string]>('SELECT * FROM projects WHERE slug = ?').get(slug);
  return row ? toProject(row) : null;
}

export function createProject(name: string): Project {
  const slug = uniqueSlug(slugify(name, 'project'), (candidate) => !!findProjectBySlug(candidate));
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

export function deleteProject(id: string): void {
  // The generated addresses of every app inside go with it; domains you own do not.
  for (const service of listServices(id)) releaseDomainsFor(service.id);
  db().query('DELETE FROM projects WHERE id = ?').run(id);
}
