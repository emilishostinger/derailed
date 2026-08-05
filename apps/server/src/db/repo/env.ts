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

export function envMap(serviceId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of listEnv(serviceId)) out[entry.key] = entry.value;
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
