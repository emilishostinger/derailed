import type { Service } from '@derailed/shared';
import { FriendlyError } from '../build/git.ts';
import { db } from '../db/index.ts';
import { findProject } from '../db/repo/projects.ts';
import {
  containerName,
  createDatabaseService,
  databasePassword,
  findService,
} from '../db/repo/services.ts';
import { createContainer, findContainerByName, startContainer } from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { managedLabels } from '../docker/labels.ts';
import { ensureProjectNetwork } from '../docker/networks.ts';
import { ensureVolume } from '../docker/volumes.ts';
import { emitService } from '../runtime/present.ts';
import { randomSecret } from '../util/crypto.ts';
import { newId, slugify } from '../util/ids.ts';
import { commandFor, type DatabaseCredentials, findEngine } from './databases.ts';

/**
 * Names a database server keeps for itself. Calling someone's database `mysql` puts
 * their tables inside the server's own bookkeeping, where a fresh start wipes them.
 */
const RESERVED_DB_NAMES = new Set([
  'mysql',
  'sys',
  'information_schema',
  'performance_schema',
  'postgres',
  'template0',
  'template1',
]);

function safeDbName(name: string): string {
  return RESERVED_DB_NAMES.has(name.toLowerCase()) ? `${name}_db` : name;
}

/**
 * Creates a database service and brings its container up. Credentials are generated
 * here and never shown until someone opens the Connection tab.
 */
export async function createDatabaseFromCatalog(
  projectId: string,
  name: string,
  engineName: string,
  version: string,
): Promise<Service> {
  const project = findProject(projectId);
  if (!project) throw new FriendlyError("That project doesn't exist.");

  const engine = findEngine(engineName);
  if (!engine) throw new FriendlyError(`Derailed doesn't know how to run "${engineName}".`);
  if (!engine.versions.includes(version)) {
    throw new FriendlyError(
      `Derailed can't run ${engine.label} ${version}.`,
      `Available versions: ${engine.versions.join(', ')}.`,
    );
  }

  const dbName = safeDbName(slugify(name, 'app').replace(/-/g, '_'));
  const service = createDatabaseService({
    projectId,
    name,
    engine: engine.engine,
    version,
    dbName: engine.usesDbName ? dbName : '',
    dbUser: engine.usesUser ? 'derailed' : '',
    dbPassword: randomSecret(32),
    port: engine.port,
  });

  try {
    await startDatabaseContainer(service.id);
  } catch (err) {
    // Don't leave a half-created service behind if Docker refuses.
    db().query('DELETE FROM services WHERE id = ?').run(service.id);
    throw err;
  }

  return findService(service.id)!;
}

export function credentialsFor(service: Service): DatabaseCredentials | null {
  const project = findProject(service.projectId);
  const password = databasePassword(service.id);
  if (!project || !password) return null;
  return {
    host: containerName(project.slug, service.slug),
    dbName: service.dbName ?? '',
    user: service.dbUser ?? '',
    password,
  };
}

export function connectionUrl(service: Service): string | null {
  const engine = findEngine(service.dbEngine ?? '');
  const credentials = credentialsFor(service);
  if (!engine || !credentials) return null;
  return engine.urlTemplate(credentials);
}

/** Idempotent: adopts an existing container, otherwise creates and starts one. */
export async function startDatabaseContainer(serviceId: string): Promise<string> {
  const service = findService(serviceId);
  if (service?.kind !== 'database') {
    throw new FriendlyError("That database doesn't exist.");
  }
  const project = findProject(service.projectId)!;
  const engine = findEngine(service.dbEngine ?? '');
  const credentials = credentialsFor(service);
  if (!engine || !credentials) throw new FriendlyError('That database is missing its settings.');

  const name = containerName(project.slug, service.slug);
  const existing = await findContainerByName(name);
  if (existing) {
    if (existing.State !== 'running') await startContainer(existing.Id);
    emitService(service.id);
    return existing.Id;
  }

  const image = engine.image(service.dbVersion ?? engine.versions[0]!);
  if (!(await imageExists(image))) await pullImage(image);

  const network = await ensureProjectNetwork(project.id);
  const volumeName = `derailed-v-${service.id}`;
  await ensureVolume(
    volumeName,
    managedLabels({ projectId: project.id, serviceId: service.id, role: 'database' }),
  );
  db()
    .query(
      'INSERT OR IGNORE INTO volumes (id, service_id, name, container_path, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(newId(), service.id, volumeName, engine.volumePath, Date.now());

  const containerId = await createContainer({
    name,
    image,
    cmd: commandFor(engine, credentials),
    env: engine.env(credentials),
    labels: managedLabels({
      projectId: project.id,
      serviceId: service.id,
      role: 'database',
    }),
    network,
    aliases: [service.slug, name],
    volumes: { [volumeName]: engine.volumePath },
    // Databases stay internal unless someone explicitly exposes them.
    ports: service.exposedPort
      ? { [engine.port]: { host: '0.0.0.0', port: service.exposedPort } }
      : {},
    memoryLimitMb: service.memoryLimitMb,
    restartPolicy: 'unless-stopped',
    healthcheck: { test: engine.healthCmd(credentials), intervalSeconds: 10, retries: 6 },
  });

  await startContainer(containerId);
  emitService(service.id);
  return containerId;
}
