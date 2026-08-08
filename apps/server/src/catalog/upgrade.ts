import type { DbUpgrade, Service } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { restoreSnapshot, takeSnapshot } from '../backup/snapshots.ts';
import { FriendlyError } from '../build/git.ts';
import { db } from '../db/index.ts';
import {
  createDbUpgrade,
  findDbUpgrade,
  listDbUpgrades,
  updateDbUpgrade,
  upgradesDueCleanup,
} from '../db/repo/dbupgrades.ts';
import { findProject } from '../db/repo/projects.ts';
import { containerName, findService, updateService } from '../db/repo/services.ts';
import {
  destroyContainer,
  findContainerByName,
  inspectContainer,
  removeContainer,
  renameContainer,
  startContainer,
  stopContainer,
} from '../docker/containers.ts';
import { removeVolume } from '../docker/volumes.ts';
import { publishAll } from '../events/bus.ts';
import { emitService } from '../runtime/present.ts';
import { startDatabaseContainer } from './create.ts';
import { findEngine } from './databases.ts';

/**
 * Major-version upgrades, made boring.
 *
 * Postgres 15 to 16 is currently the person's problem, and it is exactly the kind
 * of problem this product exists to remove. The same three promises as updating an
 * app, and one more:
 *
 * 1. **A copy first.** A snapshot is taken through the machinery the Copies tab
 *    already trusts. No copy, no upgrade.
 * 2. **The new engine proves itself.** It starts on a fresh, version-correct
 *    volume, has to pass its own health check, and has to swallow the whole
 *    restore without an error before anything is called done.
 * 3. **Failure puts everything back.** Any slip after the switch begins reverses
 *    it: the new engine and its volume are removed, the old one gets its name
 *    back and starts again. The message says the database is where it was.
 * 4. **The old engine is kept for a week.** Stopped, renamed out of the way, data
 *    intact. Not because the restore is doubted, but because the week after an
 *    upgrade is when the doubt would surface, and "it is still here" is a
 *    different sentence from "the backup should work".
 *
 * Redis and Valkey take a shorter road: their data files are read forward by
 * newer servers and there is no way to feed a dump to a running one, so the new
 * version starts on the *same* volume, and failure is the same rename-back.
 */

const KEEP_OLD_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Engines whose data files a newer server reads directly; no dump and reload. */
const FILE_COMPATIBLE = new Set(['redis', 'valkey']);

function emitUpgrade(upgrade: DbUpgrade): void {
  const service = findService(upgrade.serviceId);
  const relevant = [topics.service(upgrade.serviceId)];
  if (service) relevant.push(topics.project(service.projectId));
  publishAll(relevant, { type: 'service.dbupgrade', upgrade });
}

/** `10.11` against `8.4`, numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** The versions this database could move up to. Never down: that is a restore. */
export function upgradeTargets(service: Service): string[] {
  const engine = findEngine(service.dbEngine ?? '');
  if (!engine || !service.dbVersion) return [];
  return engine.versions
    .filter((version) => compareVersions(version, service.dbVersion!) > 0)
    .sort(compareVersions)
    .reverse();
}

async function waitHealthy(containerId: string, timeoutMs = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = await inspectContainer(containerId).catch(() => null);
    const health = (
      inspected as { State?: { Health?: { Status?: string }; Running?: boolean } } | null
    )?.State;
    if (health?.Health?.Status === 'healthy') return true;
    if (health && health.Running === false) return false;
    await Bun.sleep(1000);
  }
  return false;
}

function setVolumeRowName(serviceId: string, containerPath: string, name: string): void {
  db()
    .query('UPDATE volumes SET name = ? WHERE service_id = ? AND container_path = ?')
    .run(name, serviceId, containerPath);
}

/**
 * Starts one upgrade. Same shape as an app update: the row answers the HTTP
 * request, `done` is for the tests and anything that wants to wait.
 */
export async function beginDbUpgrade(
  serviceId: string,
  targetVersion: string,
): Promise<{ upgrade: DbUpgrade; done: Promise<DbUpgrade> }> {
  const service = findService(serviceId);
  if (service?.kind !== 'database') throw new FriendlyError('That database no longer exists.');
  const engine = findEngine(service.dbEngine ?? '');
  if (!engine || !service.dbVersion) {
    throw new FriendlyError('That database is missing its settings.');
  }
  if (!engine.versions.includes(targetVersion)) {
    throw new FriendlyError(
      `Derailed can't run ${engine.label} ${targetVersion}.`,
      `Available versions: ${engine.versions.join(', ')}.`,
    );
  }
  if (compareVersions(targetVersion, service.dbVersion) <= 0) {
    throw new FriendlyError(
      `This database is already on ${engine.label} ${service.dbVersion}.`,
      'Moving down a version is a restore into a new database, not an upgrade.',
    );
  }
  if (service.walArchive) {
    throw new FriendlyError(
      'Turn off the point-in-time archive before upgrading.',
      'The archive belongs to one version of the engine; it can be turned back on after.',
    );
  }
  if (inFlight.has(serviceId)) throw new FriendlyError('This database is already upgrading.');
  inFlight.add(serviceId);

  const upgrade = createDbUpgrade(serviceId, service.dbVersion, targetVersion);
  emitUpgrade(upgrade);
  const done = carryOutUpgrade(upgrade.id, service, engine.engine, targetVersion).finally(() =>
    inFlight.delete(serviceId),
  );
  return { upgrade, done };
}

const inFlight = new Set<string>();

/** The whole flow, awaited. */
export async function runDbUpgrade(serviceId: string, target: string): Promise<DbUpgrade> {
  const { done } = await beginDbUpgrade(serviceId, target);
  return done;
}

async function carryOutUpgrade(
  upgradeId: string,
  service: Service,
  engineName: string,
  target: string,
): Promise<DbUpgrade> {
  let upgrade = findDbUpgrade(upgradeId)!;
  const from = upgrade.fromVersion;
  const project = findProject(service.projectId)!;
  const stableName = containerName(project.slug, service.slug);
  const engine = findEngine(engineName)!;
  const fileCompatible = FILE_COMPATIBLE.has(engineName);

  const fail = (message: string): DbUpgrade => {
    upgrade = updateDbUpgrade(upgrade.id, {
      status: 'failed',
      message,
      finishedAt: Date.now(),
    })!;
    emitUpgrade(upgrade);
    return upgrade;
  };

  // 1. The copy. For the file-compatible engines a snapshot is still taken when
  // possible (it is the honest thing to have around), but the data never leaves
  // its volume, so a database that cannot be dumped can still move.
  let snapshotId: string | null = null;
  const snapshot = await takeSnapshot(service.id).catch(() => null);
  if (snapshot) {
    snapshotId = snapshot.id;
    upgrade = updateDbUpgrade(upgrade.id, { snapshotId })!;
  } else if (!fileCompatible) {
    return fail(
      'A copy could not be taken, so nothing was touched. The database has to be running to upgrade it.',
    );
  }

  // 2. The switch. From here on, every failure path puts things back.
  upgrade = updateDbUpgrade(upgrade.id, { status: 'switching' })!;
  emitUpgrade(upgrade);

  const oldName = `${stableName}-old-${from.replace(/\./g, '-')}`;
  const oldVolume = fileCompatible
    ? null
    : (db()
        .query<{ name: string }, [string, string]>(
          'SELECT name FROM volumes WHERE service_id = ? AND container_path = ?',
        )
        .get(service.id, engine.volumePath)?.name ?? `derailed-v-${service.id}`);
  const newVolume = fileCompatible
    ? null
    : `derailed-v-${service.id}-${target.replace(/\./g, '-')}`;

  const existing = await findContainerByName(stableName);
  if (!existing) {
    return fail('The database has no container to upgrade. Start it first.');
  }

  let renamed = false;
  let newContainerId: string | null = null;
  try {
    await stopContainer(existing.Id, 30);
    await renameContainer(existing.Id, oldName);
    renamed = true;

    if (newVolume) setVolumeRowName(service.id, engine.volumePath, newVolume);
    updateService(service.id, { dbVersion: target });

    newContainerId = await startDatabaseContainer(service.id);
    const healthy = await waitHealthy(newContainerId);
    if (!healthy) {
      throw new FriendlyError(
        `${engine.label} ${target} started but never reported itself healthy.`,
      );
    }

    // 3. The data. File-compatible engines brought it with them; the rest reload
    // the snapshot and refuse to call any error a success.
    if (!fileCompatible && snapshotId) {
      await restoreSnapshot(snapshotId);
    }

    upgrade = updateDbUpgrade(upgrade.id, {
      status: 'ok',
      oldContainer: oldName,
      oldVolume,
      cleanupAfter: Date.now() + KEEP_OLD_FOR_MS,
      message: `Moved from ${engine.label} ${from} to ${target}. The old engine is kept, stopped, for a week, in case the week has other plans.`,
      finishedAt: Date.now(),
    })!;
    emitUpgrade(upgrade);
    emitService(service.id);
    return upgrade;
  } catch (err) {
    // Put it all back: new engine gone, old name restored, old engine running.
    if (newContainerId) await destroyContainer(newContainerId, 5).catch(() => undefined);
    if (newVolume) {
      await removeVolume(newVolume).catch(() => undefined);
      setVolumeRowName(service.id, engine.volumePath, oldVolume!);
    }
    updateService(service.id, { dbVersion: from });
    if (renamed) {
      await renameContainer(existing.Id, stableName).catch(() => undefined);
      await startContainer(existing.Id).catch(() => undefined);
    }
    emitService(service.id);
    const reason = err instanceof FriendlyError ? err.message : 'Something went wrong.';
    return fail(
      `${reason} Everything was put back: the database is running ${engine.label} ${from} with its data untouched.`,
    );
  }
}

/** Everything the database screen needs in one answer. */
export function dbUpgradeState(serviceId: string): {
  targets: string[];
  history: DbUpgrade[];
} {
  const service = findService(serviceId);
  if (service?.kind !== 'database') throw new FriendlyError('That database no longer exists.');
  return {
    targets: upgradeTargets(service),
    history: listDbUpgrades(serviceId),
  };
}

/**
 * Tidies away old engines whose week is up: the stopped container and, where the
 * upgrade reloaded data into a fresh volume, the old volume too.
 */
export async function sweepRetiredEngines(now = Date.now()): Promise<number> {
  let cleaned = 0;
  for (const due of upgradesDueCleanup(now)) {
    if (due.oldContainer) {
      const container = await findContainerByName(due.oldContainer).catch(() => null);
      if (container) await removeContainer(container.Id).catch(() => undefined);
    }
    if (due.oldVolume) await removeVolume(due.oldVolume).catch(() => undefined);
    updateDbUpgrade(due.id, { cleanedAt: Date.now() });
    cleaned++;
  }
  return cleaned;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDbUpgradeSweep(): void {
  if (timer) return;
  timer = setInterval(() => void sweepRetiredEngines(), 24 * 60 * 60 * 1000);
  timer.unref?.();
}

export function stopDbUpgradeSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
