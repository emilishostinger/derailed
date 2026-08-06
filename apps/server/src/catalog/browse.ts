import type { QueryResult, TableSummary } from '@derailed/shared';
import { findService } from '../db/repo/services.ts';
import { dockerFetch, dockerJson } from '../docker/client.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { demultiplex } from '../jobs/run.ts';
import { credentialsFor } from './create.ts';

/**
 * Looking inside a database.
 *
 * Databases are one click to create and then a black box for ever, which leaves
 * "is my data actually in there?" answerable only by installing a client and
 * remembering a connection string. That is the last real reason to SSH into the
 * machine, and it should not be.
 *
 * Everything here runs the engine's own client inside the database's own container,
 * so there is no driver to bundle, no port to expose, and nothing new listening
 * anywhere. It is the same trick the backups already use.
 */

export type Engine = 'postgres' | 'mysql' | 'mariadb';

/** Which engines can be browsed. Redis and Mongo are not tables and need their own screen. */
export function canBrowse(engine: string | null): engine is Engine {
  return engine === 'postgres' || engine === 'mysql' || engine === 'mariadb';
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/**
 * Runs one statement through the engine's own client and returns what it printed.
 *
 * The statement is passed as an argument rather than interpolated into a shell string.
 * There is no shell here at all: `Cmd` is an argv, so a table name containing a
 * semicolon is a table name and not a second command.
 */
async function runClient(
  containerId: string,
  engine: Engine,
  sql: string,
  credentials: { user: string; dbName: string; password: string },
): Promise<string> {
  const cmd =
    engine === 'postgres'
      ? [
          'psql',
          '-U',
          credentials.user,
          '-d',
          credentials.dbName,
          // Unaligned, separated by a unit character, no ornament. Parsing a human
          // table back into columns is guesswork; this is not.
          '--no-align',
          '--field-separator=',
          '--pset=footer=off',
          '--command',
          sql,
        ]
      : [
          engine === 'mariadb' ? 'mariadb' : 'mysql',
          '-u',
          credentials.user,
          '--batch',
          '--raw',
          credentials.dbName,
          '--execute',
          sql,
        ];

  const { Id } = await dockerJson<{ Id: string }>(`/containers/${containerId}/exec`, {
    method: 'POST',
    json: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: cmd,
      Env:
        engine === 'postgres'
          ? [`PGPASSWORD=${credentials.password}`]
          : [`MYSQL_PWD=${credentials.password}`],
    },
  });

  const response = await dockerFetch(`/exec/${Id}/start`, {
    method: 'POST',
    json: { Detach: false, Tty: false },
    timeoutMs: 30_000,
  });

  const output = demultiplex(new Uint8Array(await response.arrayBuffer()));
  const inspected = await dockerJson<{ ExitCode: number | null }>(`/exec/${Id}/json`);
  if (inspected.ExitCode !== 0) throw new Error(tidyError(output));
  return output;
}

/** The engine's complaint, without the boilerplate around it. */
function tidyError(output: string): string {
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /error/i.test(entry));
  return (line ?? (output.trim() || 'The database refused that.')).slice(0, 400);
}

/** Splits the client's output into rows and columns. */
function parseRows(engine: Engine, output: string): { columns: string[]; rows: string[][] } {
  const separator = engine === 'postgres' ? '' : '\t';
  const lines = output.split('\n').filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };

  const [header = '', ...rest] = lines;
  return {
    columns: header.split(separator),
    rows: rest.map((line) => line.split(separator)),
  };
}

const TABLE_LIST: Record<Engine, string> = {
  postgres: `SELECT table_name, (SELECT n_live_tup FROM pg_stat_user_tables s WHERE s.relname = t.table_name)
             FROM information_schema.tables t
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`,
  mysql: `SELECT table_name, table_rows FROM information_schema.tables
          WHERE table_schema = DATABASE() ORDER BY table_name`,
  mariadb: `SELECT table_name, table_rows FROM information_schema.tables
            WHERE table_schema = DATABASE() ORDER BY table_name`,
};

export async function listTables(serviceId: string): Promise<TableSummary[]> {
  const service = findService(serviceId);
  const credentials = service && credentialsFor(service);
  const containerId = await runningContainer(serviceId);
  if (!service || !credentials || !containerId || !canBrowse(service.dbEngine)) return [];

  const output = await runClient(containerId, service.dbEngine, TABLE_LIST[service.dbEngine], {
    user: credentials.user,
    dbName: credentials.dbName,
    password: credentials.password,
  });

  return parseRows(service.dbEngine, output)
    .rows.filter((row) => row[0])
    .map((row) => ({
      name: row[0] ?? '',
      // An estimate on both engines, and said to be one rather than presented as fact.
      approximateRows: Number(row[1] ?? 0) || 0,
    }));
}

/**
 * A page of one table.
 *
 * The table name is checked against the real list rather than escaped, because the
 * only safe way to put an identifier into a query is to know it is one you already
 * know about. Anything else is quoting rules per engine and a bug waiting to happen.
 */
export async function readTable(
  serviceId: string,
  table: string,
  limit = 100,
  offset = 0,
): Promise<QueryResult> {
  const service = findService(serviceId);
  const credentials = service && credentialsFor(service);
  const containerId = await runningContainer(serviceId);
  if (!service || !credentials || !containerId || !canBrowse(service.dbEngine)) {
    throw new Error('That database is not running.');
  }

  const known = await listTables(serviceId);
  if (!known.some((entry) => entry.name === table)) {
    throw new Error(`There is no table called "${table}" in this database.`);
  }

  const quoted = service.dbEngine === 'postgres' ? `"${table}"` : `\`${table}\``;
  const sql = `SELECT * FROM ${quoted} LIMIT ${Math.min(Math.max(1, limit), 500)} OFFSET ${Math.max(0, offset)}`;

  const output = await runClient(containerId, service.dbEngine, sql, {
    user: credentials.user,
    dbName: credentials.dbName,
    password: credentials.password,
  });

  const { columns, rows } = parseRows(service.dbEngine, output);
  return { columns, rows, truncated: rows.length >= limit, readOnly: true };
}

/**
 * Whether a statement only reads.
 *
 * Deliberately a allowlist of first words rather than a search for dangerous ones: a
 * denylist is a guess about every way somebody could write `DROP`, and being wrong
 * once means losing a database. Anything not obviously a read is refused, and the
 * person can use the Terminal tab, where it is clear what they are doing.
 */
export function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim().replace(/^\(+/, '');
  if (/;\s*\S/.test(trimmed.replace(/;\s*$/, ''))) return false;
  return /^(select|show|describe|desc|explain|with)\b/i.test(trimmed);
}

export async function runQuery(serviceId: string, sql: string): Promise<QueryResult> {
  const service = findService(serviceId);
  const credentials = service && credentialsFor(service);
  const containerId = await runningContainer(serviceId);
  if (!service || !credentials || !containerId || !canBrowse(service.dbEngine)) {
    throw new Error('That database is not running.');
  }
  if (!isReadOnly(sql)) {
    throw new Error(
      'This box only runs queries that read. Use the Terminal tab for anything that changes data.',
    );
  }

  const output = await runClient(containerId, service.dbEngine, sql, {
    user: credentials.user,
    dbName: credentials.dbName,
    password: credentials.password,
  });

  const { columns, rows } = parseRows(service.dbEngine, output);
  return { columns, rows: rows.slice(0, 500), truncated: rows.length > 500, readOnly: true };
}
