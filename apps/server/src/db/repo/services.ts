import type {
  BuildStrategy,
  HealthCheckKind,
  Service,
  ServiceKind,
  ServiceSource,
} from '@derailed/shared';
import { decrypt, encrypt } from '../../util/crypto.ts';
import { newId, slugify, uniqueSlug } from '../../util/ids.ts';
import { db } from '../index.ts';
import { releaseDomainsFor } from './domains.ts';

interface ServiceRow {
  id: string;
  project_id: string;
  kind: ServiceKind;
  name: string;
  slug: string;
  source: ServiceSource;
  image: string | null;
  framework: string | null;
  command: string | null;
  repo_url: string | null;
  branch: string | null;
  root_dir: string | null;
  build_strategy: BuildStrategy;
  dockerfile_path: string | null;
  port: number | null;
  health_path: string;
  instances_desired: 0 | 1;
  memory_limit_mb: number | null;
  deploy_on_release: 0 | 1;
  last_release_tag: string | null;
  deploy_on_push: 0 | 1;
  last_pushed_sha: string | null;
  db_engine: string | null;
  db_version: string | null;
  db_name: string | null;
  db_user: string | null;
  db_password_enc: string | null;
  repo_token_enc: string | null;
  exposed_port: number | null;
  snapshot_every_hours?: number | null;
  auto_update?: 0 | 1;
  wal_archive?: 0 | 1;
  alias?: string | null;
  health_check?: HealthCheckKind;
  health_expect?: string | null;
  health_command?: string | null;
  forms?: 0 | 1;
  bot_mode?: 'off' | 'polite' | 'strict';
  block_ai?: 0 | 1;
  img_resize?: 0 | 1;
  login_required?: 0 | 1;
  allowed_emails?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  auth_user?: string | null;
  auth_hash?: string | null;
  allow_from?: string | null;
  block_from?: string | null;
  maintenance?: 0 | 1;
}

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    // Rows written before this column existed are repositories by definition.
    source: row.source ?? 'repo',
    image: row.image,
    framework: row.framework,
    command: row.command ? (JSON.parse(row.command) as string[]) : null,
    repoUrl: row.repo_url,
    branch: row.branch,
    rootDir: row.root_dir,
    buildStrategy: row.build_strategy,
    dockerfilePath: row.dockerfile_path,
    port: row.port,
    healthPath: row.health_path,
    instancesDesired: row.instances_desired,
    memoryLimitMb: row.memory_limit_mb,
    deployOnRelease: row.deploy_on_release === 1,
    lastReleaseTag: row.last_release_tag,
    deployOnPush: row.deploy_on_push === 1,
    lastPushedSha: row.last_pushed_sha,
    dbEngine: row.db_engine,
    dbVersion: row.db_version,
    dbName: row.db_name,
    dbUser: row.db_user,
    exposedPort: row.exposed_port,
    snapshotEveryHours: row.snapshot_every_hours ?? null,
    autoUpdate: row.auto_update === 1,
    walArchive: row.wal_archive === 1,
    alias: row.alias ?? null,
    healthCheck: row.health_check ?? 'http',
    healthExpect: row.health_expect ?? null,
    healthCommand: row.health_command ?? null,
    forms: row.forms === 1,
    botMode: row.bot_mode ?? 'off',
    blockAi: row.block_ai === 1,
    imgResize: row.img_resize === 1,
    loginRequired: row.login_required === 1,
    allowedEmails: row.allowed_emails ? (JSON.parse(row.allowed_emails) as string[]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    // The hash is never included: it is Caddy's business, not the browser's.
    access: {
      hasPassword: !!row.auth_hash,
      username: row.auth_user ?? null,
      allowFrom: row.allow_from ? (JSON.parse(row.allow_from) as string[]) : [],
      blockFrom: row.block_from ? (JSON.parse(row.block_from) as string[]) : [],
      maintenance: row.maintenance === 1,
    },
  };
}

/**
 * Everything still in use. Deleted services keep their rows for a week so they can be
 * put back, and every ordinary read has to leave those out: an app in the trash must
 * not be deployed, routed, backed up, monitored or counted.
 */
export function listServices(projectId?: string): Service[] {
  const query = projectId
    ? db()
        .query<ServiceRow, [string]>(
          'SELECT * FROM services WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at',
        )
        .all(projectId)
    : db()
        .query<ServiceRow, []>(
          'SELECT * FROM services WHERE deleted_at IS NULL ORDER BY created_at',
        )
        .all();
  return query.map(toService);
}

/** Including deleted ones. For the trash, restoring, and emptying it. */
export function listServicesEvenIfDeleted(projectId?: string): Service[] {
  const query = projectId
    ? db()
        .query<ServiceRow, [string]>(
          'SELECT * FROM services WHERE project_id = ? ORDER BY created_at',
        )
        .all(projectId)
    : db().query<ServiceRow, []>('SELECT * FROM services ORDER BY created_at').all();
  return query.map(toService);
}

export function listDeletedServices(): Service[] {
  return db()
    .query<ServiceRow, []>(
      'SELECT * FROM services WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    )
    .all()
    .map(toService);
}

export function findService(id: string): Service | null {
  const row = db()
    .query<ServiceRow, [string]>('SELECT * FROM services WHERE id = ? AND deleted_at IS NULL')
    .get(id);
  return row ? toService(row) : null;
}

export function findServiceEvenIfDeleted(id: string): Service | null {
  const row = db().query<ServiceRow, [string]>('SELECT * FROM services WHERE id = ?').get(id);
  return row ? toService(row) : null;
}

export function findServiceBySlug(projectId: string, slug: string): Service | null {
  const row = db()
    .query<ServiceRow, [string, string]>(
      'SELECT * FROM services WHERE project_id = ? AND slug = ? AND deleted_at IS NULL',
    )
    .get(projectId, slug);
  return row ? toService(row) : null;
}

export interface NewAppService {
  projectId: string;
  name: string;
  source?: ServiceSource;
  /** Required when source is 'image'. */
  image?: string | null;
  framework?: string | null;
  /** Only for images whose default command does not start the thing you want. */
  command?: string[] | null;
  repoUrl: string | null;
  branch: string | null;
  rootDir?: string | null;
  buildStrategy?: BuildStrategy;
  dockerfilePath?: string | null;
  port?: number | null;
  healthPath?: string;
  /** An extra name this service answers to on the project network. */
  alias?: string | null;
  /** 'http' answers on a port; 'started' just has to keep running. */
  healthCheck?: HealthCheckKind;
  /** Whether the proxy catches this app's form posts. */
  forms?: boolean;
}

export interface NewDatabaseService {
  projectId: string;
  name: string;
  engine: string;
  version: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  port: number;
}

function nextSlug(projectId: string, name: string, fallback: string): string {
  // Taken must include deleted services: their rows are still there, `(project_id,
  // slug)` is still UNIQUE, and reusing the name of something in the trash would
  // otherwise fail on a constraint with nothing on screen to explain it.
  return uniqueSlug(
    slugify(name, fallback),
    (candidate) =>
      !!db()
        .query<{ id: string }, [string, string]>(
          'SELECT id FROM services WHERE project_id = ? AND slug = ?',
        )
        .get(projectId, candidate),
  );
}

export function createAppService(input: NewAppService): Service {
  const now = Date.now();
  const id = newId();
  const slug = nextSlug(input.projectId, input.name, 'app');
  db()
    .query(
      `INSERT INTO services
        (id, project_id, kind, name, slug, source, image, framework, command, repo_url, branch,
         root_dir, build_strategy, dockerfile_path, port, health_path, instances_desired,
         alias, health_check, forms, created_at, updated_at)
       VALUES (?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.name,
      slug,
      input.source ?? 'repo',
      input.image ?? null,
      input.framework ?? null,
      input.command ? JSON.stringify(input.command) : null,
      input.repoUrl,
      input.branch,
      input.rootDir ?? null,
      input.buildStrategy ?? 'auto',
      input.dockerfilePath ?? null,
      input.port ?? null,
      input.healthPath ?? '/',
      input.alias ?? null,
      input.healthCheck ?? 'http',
      // On for dragged-in folders unless said otherwise: they are who forms are
      // for, and they have no backend of their own to break.
      (input.forms ?? input.source === 'upload') ? 1 : 0,
      now,
      now,
    );
  return findService(id)!;
}

export function createDatabaseService(input: NewDatabaseService): Service {
  const now = Date.now();
  const id = newId();
  const slug = nextSlug(input.projectId, input.name, 'db');
  db()
    .query(
      `INSERT INTO services
        (id, project_id, kind, name, slug, db_engine, db_version, db_name, db_user,
         db_password_enc, port, instances_desired, created_at, updated_at)
       VALUES (?, ?, 'database', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.name,
      slug,
      input.engine,
      input.version,
      input.dbName,
      input.dbUser,
      encrypt(input.dbPassword),
      input.port,
      now,
      now,
    );
  return findService(id)!;
}

/** Deploy tokens never leave the server at all, not even to the Connection tab. */
export function repoToken(serviceId: string): string | null {
  const row = db()
    .query<{ repo_token_enc: string | null }, [string]>(
      'SELECT repo_token_enc FROM services WHERE id = ?',
    )
    .get(serviceId);
  return row?.repo_token_enc ? decrypt(row.repo_token_enc) : null;
}

export function setRepoToken(serviceId: string, token: string | null): void {
  db()
    .query('UPDATE services SET repo_token_enc = ?, updated_at = ? WHERE id = ?')
    .run(token ? encrypt(token) : null, Date.now(), serviceId);
}

/** Database passwords never leave the server except through the Connection tab. */
export function databasePassword(serviceId: string): string | null {
  const row = db()
    .query<{ db_password_enc: string | null }, [string]>(
      'SELECT db_password_enc FROM services WHERE id = ?',
    )
    .get(serviceId);
  return row?.db_password_enc ? decrypt(row.db_password_enc) : null;
}

const UPDATABLE: Record<string, string> = {
  deployOnRelease: 'deploy_on_release',
  lastReleaseTag: 'last_release_tag',
  deployOnPush: 'deploy_on_push',
  lastPushedSha: 'last_pushed_sha',
  name: 'name',
  branch: 'branch',
  rootDir: 'root_dir',
  buildStrategy: 'build_strategy',
  dockerfilePath: 'dockerfile_path',
  port: 'port',
  healthPath: 'health_path',
  healthCheck: 'health_check',
  healthExpect: 'health_expect',
  healthCommand: 'health_command',
  instancesDesired: 'instances_desired',
  memoryLimitMb: 'memory_limit_mb',
  exposedPort: 'exposed_port',
  source: 'source',
  image: 'image',
  framework: 'framework',
  snapshotEveryHours: 'snapshot_every_hours',
  autoUpdate: 'auto_update',
  dbVersion: 'db_version',
  walArchive: 'wal_archive',
  forms: 'forms',
  botMode: 'bot_mode',
  blockAi: 'block_ai',
  imgResize: 'img_resize',
};

export function updateService(
  id: string,
  patch: Record<string, string | number | boolean | null | undefined>,
): Service | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    // SQLite has no boolean. Converting here rather than at each call site means a
    // flag cannot reach a column as the string "true" and read back as truthy.
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (assignments.length) {
    assignments.push('updated_at = ?');
    values.push(Date.now());
    db()
      .query(`UPDATE services SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, id);
  }
  return findService(id);
}

/**
 * Marks a service deleted, keeping everything that holds data.
 *
 * Its domains are released now rather than at purge: the app stops answering the
 * moment it is deleted, and a name left attached to something silent is worse than a
 * name free to be pointed somewhere useful.
 */
export function softDeleteService(id: string, at = Date.now()): void {
  releaseDomainsFor(id);
  db().query('UPDATE services SET deleted_at = ? WHERE id = ?').run(at, id);
}

/**
 * Who may see this app.
 *
 * The password is hashed here and never stored in the clear: Caddy checks it against
 * the hash, and Derailed has no reason to be able to read it back. Passing null for
 * the password clears it; leaving it undefined keeps whatever is stored.
 */
export async function setAccess(
  id: string,
  patch: {
    username?: string | null;
    password?: string | null;
    allowFrom?: string[] | null;
    blockFrom?: string[] | null;
    maintenance?: boolean;
  },
): Promise<Service | null> {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.password === null) {
    assignments.push('auth_user = NULL', 'auth_hash = NULL');
  } else if (patch.password !== undefined && patch.password !== '') {
    // bcrypt, because that is what Caddy's http_basic provider verifies against.
    assignments.push('auth_user = ?', 'auth_hash = ?');
    values.push(
      patch.username?.trim() || 'visitor',
      await Bun.password.hash(patch.password, { algorithm: 'bcrypt', cost: 12 }),
    );
  } else if (patch.username !== undefined && patch.username !== null) {
    assignments.push('auth_user = ?');
    values.push(patch.username.trim() || 'visitor');
  }

  if (patch.allowFrom !== undefined) {
    assignments.push('allow_from = ?');
    values.push(patch.allowFrom?.length ? JSON.stringify(patch.allowFrom) : null);
  }
  if (patch.blockFrom !== undefined) {
    assignments.push('block_from = ?');
    values.push(patch.blockFrom?.length ? JSON.stringify(patch.blockFrom) : null);
  }
  if (patch.maintenance !== undefined) {
    assignments.push('maintenance = ?');
    values.push(patch.maintenance ? 1 : 0);
  }

  if (!assignments.length) return findService(id);

  assignments.push('updated_at = ?');
  values.push(Date.now());
  db()
    .query(`UPDATE services SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return findService(id);
}

/** The hash, for building the proxy configuration. Never leaves the server. */
export function accessFor(id: string): {
  username: string;
  hash: string;
} | null {
  const row = db()
    .query<{ auth_user: string | null; auth_hash: string | null }, [string]>(
      'SELECT auth_user, auth_hash FROM services WHERE id = ?',
    )
    .get(id);
  if (!row?.auth_hash) return null;
  return { username: row.auth_user ?? 'visitor', hash: row.auth_hash };
}

export function restoreService(id: string): void {
  db().query('UPDATE services SET deleted_at = NULL WHERE id = ?').run(id);
}

/** For real, and for ever. Only the trash sweep and "delete now" call this. */
export function deleteService(id: string): void {
  releaseDomainsFor(id);
  db().query('DELETE FROM services WHERE id = ?').run(id);
}

/** Container names are how Caddy and linked apps address a service on the network. */
export function containerName(
  projectSlug: string,
  serviceSlug: string,
  deploymentId?: string,
): string {
  const base = `d_${projectSlug}_${serviceSlug}`;
  return deploymentId ? `${base}_${deploymentId.slice(0, 8)}` : base;
}
