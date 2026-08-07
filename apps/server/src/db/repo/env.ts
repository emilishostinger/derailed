import type { EnvSource, EnvVar } from '@derailed/shared';
import { decrypt, encrypt } from '../../util/crypto.ts';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

interface EnvRow {
  id: string;
  service_id: string;
  key: string;
  value_enc: string;
  source: EnvSource;
}

const toEnvVar = (row: EnvRow): EnvVar => ({
  id: row.id,
  serviceId: row.service_id,
  key: row.key,
  value: decrypt(row.value_enc),
  source: row.source,
});

export function listEnv(serviceId: string): EnvVar[] {
  return db()
    .query<EnvRow, [string]>('SELECT * FROM env_vars WHERE service_id = ? ORDER BY key')
    .all(serviceId)
    .map(toEnvVar);
}

interface ProjectEnvRow {
  id: string;
  project_id: string;
  key: string;
  value_enc: string;
}

/**
 * Variables shared by everything in a project.
 *
 * An API key, a timezone, an error-reporting address: things that are true of the
 * project rather than of one app in it. Setting the same value on five apps by hand
 * is five chances to fat-finger one, and rotating it later means finding all five and
 * remembering which they were.
 */
export function listProjectEnv(projectId: string): { key: string; value: string }[] {
  return db()
    .query<ProjectEnvRow, [string]>('SELECT * FROM project_env WHERE project_id = ? ORDER BY key')
    .all(projectId)
    .map((row) => ({ key: row.key, value: decrypt(row.value_enc) }));
}

export function replaceProjectEnv(projectId: string, vars: { key: string; value: string }[]): void {
  db().transaction(() => {
    db().query('DELETE FROM project_env WHERE project_id = ?').run(projectId);
    for (const entry of vars) {
      db()
        .query('INSERT INTO project_env (id, project_id, key, value_enc) VALUES (?, ?, ?, ?)')
        .run(newId(), projectId, entry.key, encrypt(entry.value));
    }
  })();
}

/**
 * What an app actually gets, shared variables included.
 *
 * The project's come first and the app's own overwrite them, so a shared value is a
 * default rather than a decree: an app that needs a different one sets it and wins,
 * without anybody having to remove it from the project first. Any other order would
 * make the shared list a thing you have to fight.
 */
export function effectiveEnv(serviceId: string): EnvVar[] {
  const own = listEnv(serviceId);
  const service = db()
    .query<{ project_id: string }, [string]>('SELECT project_id FROM services WHERE id = ?')
    .get(serviceId);
  if (!service) return own;

  const ownKeys = new Set(own.map((entry) => entry.key));
  const shared: EnvVar[] = listProjectEnv(service.project_id)
    .filter((entry) => !ownKeys.has(entry.key))
    .map((entry) => ({
      // Not a stored row, so it has no id of its own. The key is what identifies it
      // on the screen, and the screen is the only thing that sees this.
      id: `project:${entry.key}`,
      serviceId,
      key: entry.key,
      value: entry.value,
      source: 'project' as const,
    }));

  return [...own, ...shared].sort((a, b) => a.key.localeCompare(b.key));
}

export function envMap(serviceId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of effectiveEnv(serviceId)) out[entry.key] = entry.value;
  return out;
}

export function setEnv(
  serviceId: string,
  key: string,
  value: string,
  source: EnvSource = 'user',
): void {
  db()
    .query(
      `INSERT INTO env_vars (id, service_id, key, value_enc, source) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service_id, key) DO UPDATE SET value_enc = excluded.value_enc, source = excluded.source`,
    )
    .run(newId(), serviceId, key, encrypt(value), source);
}

export function deleteEnv(serviceId: string, key: string): void {
  db().query('DELETE FROM env_vars WHERE service_id = ? AND key = ?').run(serviceId, key);
}

/** Replaces the user-owned variables wholesale; link- and system-sourced ones survive. */
export function replaceUserEnv(serviceId: string, vars: { key: string; value: string }[]): void {
  db().transaction(() => {
    db().query(`DELETE FROM env_vars WHERE service_id = ? AND source = 'user'`).run(serviceId);
    for (const entry of vars) setEnv(serviceId, entry.key, entry.value, 'user');
  })();
}

export function deleteEnvBySource(serviceId: string, source: EnvSource): void {
  db().query('DELETE FROM env_vars WHERE service_id = ? AND source = ?').run(serviceId, source);
}

/**
 * Parses pasted .env text. Tolerates `export`, quotes, inline comments and blank
 * lines, because that is what people actually paste.
 */
export function parseDotEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing comment only when it is clearly separated.
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out.push({ key, value });
  }
  return out;
}
