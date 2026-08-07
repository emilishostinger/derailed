import type { BrowseKind } from '@derailed/shared';
import { findService } from '../db/repo/services.ts';
import { dockerFetch, dockerJson } from '../docker/client.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { demultiplex } from '../jobs/run.ts';
import { credentialsFor } from './create.ts';

/**
 * Running a database's own client, inside its own container.
 *
 * There is no driver bundled here for any of the six engines, no port opened and
 * nothing new listening anywhere. `psql`, `mysql`, `mongosh` and `valkey-cli` are
 * already in the images, they already know their own wire protocol, and they are
 * already the thing the person would have installed by hand. It is the same trick
 * the backups use.
 *
 * The rule that makes this safe is that there is never a shell. `Cmd` is an argv, so
 * a table name containing a semicolon is a table name. Where a shell is unavoidable
 * (mongosh needs its connection string out of the argument list), the script travels
 * as a positional parameter and the shell never parses it.
 */

export type SqlEngine = 'postgres' | 'mysql' | 'mariadb';
export type Engine = SqlEngine | 'mongodb' | 'redis' | 'valkey';

const KINDS: Record<Engine, BrowseKind> = {
  postgres: 'sql',
  mysql: 'sql',
  mariadb: 'sql',
  mongodb: 'documents',
  redis: 'keys',
  valkey: 'keys',
};

export function canBrowse(engine: string | null | undefined): engine is Engine {
  return engine !== null && engine !== undefined && engine in KINDS;
}

export function browseKind(engine: string | null | undefined): BrowseKind | null {
  return canBrowse(engine) ? KINDS[engine] : null;
}

export function isSql(engine: string | null | undefined): engine is SqlEngine {
  return browseKind(engine) === 'sql';
}

export interface Session {
  containerId: string;
  engine: Engine;
  user: string;
  dbName: string;
  password: string;
  host: string;
}

async function runningContainer(serviceId: string): Promise<string | null> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  return containers.find((container) => container.State === 'running')?.Id ?? null;
}

/**
 * Everything needed to talk to one database, or a refusal that says which part is
 * missing. Gathered once so no caller has to remember the four things that must line
 * up before a query can run.
 */
export async function openSession(serviceId: string): Promise<Session> {
  const service = findService(serviceId);
  if (!service) throw new Error('That database no longer exists.');
  if (!canBrowse(service.dbEngine)) {
    throw new Error(`Derailed cannot browse ${service.dbEngine ?? 'this'} yet.`);
  }

  const credentials = credentialsFor(service);
  if (!credentials) throw new Error('That database is missing its settings.');

  const containerId = await runningContainer(serviceId);
  if (!containerId) throw new Error('That database is not running, so there is nothing to read.');

  return {
    containerId,
    engine: service.dbEngine,
    user: credentials.user,
    dbName: credentials.dbName,
    password: credentials.password,
    host: credentials.host,
  };
}

/** Runs a command inside the container and returns what it printed. */
export async function exec(
  containerId: string,
  cmd: string[],
  env: string[] = [],
  timeoutMs = 30_000,
): Promise<{ code: number; out: string }> {
  const { Id } = await dockerJson<{ Id: string }>(`/containers/${containerId}/exec`, {
    method: 'POST',
    json: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, Env: env },
  });
  const response = await dockerFetch(`/exec/${Id}/start`, {
    method: 'POST',
    json: { Detach: false, Tty: false },
    timeoutMs,
  });
  const out = demultiplex(new Uint8Array(await response.arrayBuffer()));
  const inspected = await dockerJson<{ ExitCode: number | null }>(`/exec/${Id}/json`);
  return { code: inspected.ExitCode ?? 0, out };
}

/** The engine's complaint, without the boilerplate around it. */
export function tidyError(output: string): string {
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /error|denied|refused|cannot|unknown/i.test(entry));
  return (line ?? (output.trim() || 'The database refused that.')).slice(0, 400);
}

/**
 * A value as a literal the engine will accept, without any escaping rules.
 *
 * Every quoting bug in every admin tool ever written is somebody's attempt to get
 * this right by doubling apostrophes. Hex has no quoting: the bytes go in as digits
 * and come out as themselves, and a value of `'); DROP TABLE users; --` is a string
 * of forty hex digits by the time it reaches the parser. Tested with exactly that.
 *
 * `castTo` is the column's own type, looked up from the catalogue, so a number lands
 * in a number column rather than relying on whatever the engine would have coerced.
 */
export function hexLiteral(engine: SqlEngine, value: string, castTo?: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  if (engine === 'postgres') {
    const text = `convert_from(decode('${hex}','hex'),'UTF8')`;
    return castTo ? `CAST(${text} AS ${castTo})` : text;
  }
  // MySQL's `X'..'` is a *binary* string, and comparing one against a number column
  // compares bytes rather than values, so `WHERE id = X'31'` silently matches nothing.
  // Through CHAR it is an ordinary string again and the usual coercion applies.
  return `CAST(X'${hex || '00'}' AS CHAR)`;
}
