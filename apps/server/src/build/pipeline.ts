import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deployment, DeploymentStatus, DeploymentTrigger, Service } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { ensureDirs, paths } from '../config.ts';
import {
  createDeployment,
  findDeployment,
  runningDeployment,
  supersedePrevious,
  updateDeployment,
} from '../db/repo/deployments.ts';
import { createDomain, listDomains } from '../db/repo/domains.ts';
import { envMap } from '../db/repo/env.ts';
import { findProject } from '../db/repo/projects.ts';
import { containerName, findService, repoToken, updateService } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { volumeMounts } from '../db/repo/volumes.ts';
import {
  createContainer,
  destroyContainer,
  inspectContainer,
  listContainers,
  startContainer,
} from '../docker/containers.ts';
import { BuildFailed, buildImage, imageExists, pullImage } from '../docker/images.ts';
import { LABELS, labelFilter, managedLabels } from '../docker/labels.ts';
import { streamContainerLogs } from '../docker/logs.ts';
import { ensureProjectNetwork } from '../docker/networks.ts';
import { ensureVolume } from '../docker/volumes.ts';
import { publishAll } from '../events/bus.ts';
import { attachCaddyToNetwork } from '../proxy/caddy.ts';
import { generatedHostname } from '../proxy/routes.ts';
import { syncRoutes } from '../proxy/sync.ts';
import { checkDiskSpace } from '../runtime/housekeeping.ts';
import { DeploymentLog, logPathFor } from './deploylog.ts';
import { detectRepo, resolvePort, safeJoin } from './detect.ts';
import { cloneRepo, FriendlyError } from './git.ts';
import { generateDockerfile, NIXPACKS_DOCKERFILE } from './nixpacks.ts';
import { detectSite, writeSiteDockerfile } from './site.ts';
import { createTarContext } from './tar.ts';
import { hasUpload, uploadDir } from './upload.ts';

const GLOBAL_CONCURRENCY = 2;
const HEALTH_TIMEOUT_MS = 60_000;
const OLD_CONTAINER_GRACE_S = 10;

interface Job {
  deploymentId: string;
  serviceId: string;
  cancel: AbortController;
  /** Set for a rollback: reuse this image instead of cloning and building. */
  reuseImage?: string;
}

const queue: Job[] = [];
const active = new Map<string, Job>();

/** Marks a deployment for abandonment; the pipeline checks between steps. */
export function cancelDeployment(deploymentId: string): boolean {
  const running = [...active.values()].find((job) => job.deploymentId === deploymentId);
  if (running) {
    running.cancel.abort();
    return true;
  }
  const queued = queue.findIndex((job) => job.deploymentId === deploymentId);
  if (queued >= 0) {
    const [job] = queue.splice(queued, 1);
    finish(job!.deploymentId, 'canceled', {
      errorSummary: 'You cancelled this deploy before it started.',
    });
    return true;
  }
  return false;
}

/**
 * Queues a deploy. A newer deploy always wins: anything queued for the same service
 * is dropped, and anything in flight is asked to stop at its next checkpoint.
 */
export function queueDeployment(
  serviceId: string,
  trigger: DeploymentTrigger = 'manual',
  reuseImage?: string,
): Deployment {
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i]!;
    if (job.serviceId !== serviceId) continue;
    queue.splice(i, 1);
    finish(job.deploymentId, 'superseded', {
      errorSummary: 'A newer deploy replaced this one.',
    });
  }
  const inFlight = active.get(serviceId);
  if (inFlight) inFlight.cancel.abort();

  const deployment = createDeployment(serviceId, trigger);
  emitDeployment(deployment);

  queue.push({ deploymentId: deployment.id, serviceId, cancel: new AbortController(), reuseImage });
  void pump();
  return deployment;
}

function pump(): void {
  while (active.size < GLOBAL_CONCURRENCY) {
    const index = queue.findIndex((job) => !active.has(job.serviceId));
    if (index < 0) return;
    const [job] = queue.splice(index, 1);
    active.set(job!.serviceId, job!);
    void run(job!)
      .catch(() => undefined)
      .finally(() => {
        active.delete(job!.serviceId);
        pump();
      });
  }
}

export function activeJobCount(): number {
  return active.size + queue.length;
}

class Cancelled extends Error {}

async function run(job: Job): Promise<void> {
  const deployment = findDeployment(job.deploymentId);
  const service = findService(job.serviceId);
  if (!deployment || !service) return;
  const project = findProject(service.projectId);
  if (!project) return;

  // The data directories may not exist yet on a first-ever deploy. If we can't
  // create them the deploy can't start, say so instead of sitting in the queue.
  let log: DeploymentLog;
  try {
    ensureDirs();
    log = new DeploymentLog(deployment.id, service.id, project.id);
  } catch (err) {
    console.error('[derailed] cannot write to the data directory:', err);
    finish(deployment.id, 'failed', {
      errorSummary: `Derailed can't write to its data folder (${paths.dataDir}).`,
      errorHint: 'Check that the folder exists and that Derailed is allowed to write to it.',
    });
    return;
  }
  const workdir = join(paths.builds, deployment.id);
  updateDeployment(deployment.id, { startedAt: Date.now(), logPath: logPathFor(deployment.id) });

  const checkpoint = () => {
    if (job.cancel.signal.aborted) throw new Cancelled();
  };
  const step = (status: DeploymentStatus) => {
    checkpoint();
    const updated = updateDeployment(deployment.id, { status });
    if (updated) emitDeployment(updated);
  };

  try {
    if (job.reuseImage) {
      // Rollback: the image already exists, so go straight to starting it.
      await runFromImage(job, deployment, service, project, log);
      return;
    }

    // A build that runs out of disk halfway through fails with something unhelpful
    // from Docker, so check before starting and say it plainly instead.
    const disk = await checkDiskSpace();
    if (!disk.ok) {
      throw new FriendlyError(disk.message ?? 'This server is out of disk space.', disk.hint);
    }

    // A ready-made image has nothing to clone and nothing to build, pull it and run.
    if (service.source === 'image') {
      await runFromReadyImage(job, deployment, service, project, log, step);
      return;
    }

    // 1. Get the code.
    step('cloning');
    if (service.source === 'upload') {
      // Files someone dragged in, rather than a repository.
      if (!(await hasUpload(service.id))) {
        throw new FriendlyError(
          "There's nothing uploaded for this app yet.",
          'Drag a zip of your project onto the app to deploy it.',
        );
      }
      log.write('Using the files you uploaded…');
      await cp(uploadDir(service.id), workdir, { recursive: true });
    } else {
      const clone = await cloneRepo(
        service.repoUrl!,
        service.branch,
        workdir,
        (line) => log.write(line),
        repoToken(service.id),
      );
      updateDeployment(deployment.id, {
        commitSha: clone.commitSha,
        commitMessage: clone.commitMessage,
      });
    }

    // 2. Work out how to build it.
    step('detecting');
    const buildDir = safeJoin(workdir, service.rootDir);
    const detected = await detectRepo({
      dir: workdir,
      rootDir: service.rootDir,
      dockerfilePath: service.dockerfilePath,
    });
    log.write(detected.summary);
    for (const warning of detected.warnings) log.write(warning);

    // Remember what this turned out to be, so the UI can show a real logo later
    // without the repository in hand.
    if (detected.framework && detected.framework !== service.framework) {
      updateService(service.id, { framework: detected.framework });
    }

    const strategy = service.buildStrategy === 'auto' ? detected.strategy : service.buildStrategy;
    if (strategy === 'unknown') {
      throw new FriendlyError(
        "There's nothing to deploy in that repository.",
        'Check the branch, and the folder setting if the app lives in a sub-folder.',
      );
    }

    const port = resolvePort(service.port, detected.port);
    // Written down, not just used here. Routing reads the service, and if detection
    // was the only place that knew the port, Caddy would send visitors to 3000 while
    // the app listened on 80. Anything not on 3000 answered 503 until this was fixed.
    if (service.port !== port) updateService(service.id, { port });
    const userEnv = envMap(service.id);
    const runtimeEnv: Record<string, string> = { ...userEnv, PORT: String(port) };

    // 3. Build the image.
    step('building');
    const imageTag = `derailed/${service.id}:${deployment.id}`;
    let dockerfile = detected.dockerfilePath ?? 'Dockerfile';

    if (strategy === 'nixpacks') {
      await generateDockerfile(buildDir, runtimeEnv, (line, stream) => log.write(line, stream));
      dockerfile = NIXPACKS_DOCKERFILE;
    }

    if (strategy === 'site') {
      const kind = (await detectSite(buildDir)) ?? 'static';
      dockerfile = await writeSiteDockerfile(buildDir, kind);
      log.write(
        kind === 'php' ? 'Serving this with PHP and Apache.' : 'Serving these files as they are.',
      );
    }
    checkpoint();

    const context = await createTarContext(buildDir);
    log.write('Building…');
    try {
      await buildImage({
        context: context.stream,
        tag: imageTag,
        dockerfile,
        buildArgs: userEnv,
        labels: managedLabels({
          projectId: project.id,
          serviceId: service.id,
          deploymentId: deployment.id,
          role: 'build',
        }),
        onLine: (line) => log.write(line, 'build'),
        signal: job.cancel.signal,
      });
    } finally {
      const result = await context.done.catch(() => ({ ok: true, stderr: '' }));
      if (!result.ok && result.stderr) log.write(result.stderr, 'system');
    }
    updateDeployment(deployment.id, { imageTag });

    // 4-7. Start it, wait for it, route to it, retire the old one.
    await launch({ job, deployment, service, project, log, imageTag, port, runtimeEnv, step });
  } catch (err) {
    if (err instanceof Cancelled || job.cancel.signal.aborted) {
      log.write('This deploy was stopped.');
      await cleanupFailedContainer(deployment.id);
      finish(deployment.id, 'canceled', {
        errorSummary: 'This deploy was stopped before it finished.',
      });
    } else {
      // Also goes to the server log, so `journalctl -u derailed` shows the raw cause.
      console.error(`[derailed] deploy ${deployment.id} failed:`, err);
      const explained = explain(err);
      // `detail` is for the error card in the UI; the underlying lines are already
      // in the log, so re-writing them here would just duplicate the output.
      log.write(explained.summary);
      if (explained.hint) log.write(explained.hint);
      await cleanupFailedContainer(deployment.id);
      finish(deployment.id, 'failed', {
        errorSummary: explained.summary,
        errorHint: explained.hint ?? null,
      });
    }
  } finally {
    await log.flush();
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function finish(
  deploymentId: string,
  status: DeploymentStatus,
  extra: { errorSummary?: string; errorHint?: string | null } = {},
): void {
  const updated = updateDeployment(deploymentId, {
    status,
    finishedAt: Date.now(),
    ...extra,
  });
  if (updated) emitDeployment(updated);
}

function emitDeployment(deployment: Deployment): void {
  const service = findService(deployment.serviceId);
  const relevant = [topics.deployment(deployment.id), topics.service(deployment.serviceId)];
  if (service) relevant.push(topics.project(service.projectId));
  publishAll(relevant, { type: 'deployment.updated', deployment });
  publishAll(relevant, {
    type: 'deployment.status',
    deploymentId: deployment.id,
    serviceId: deployment.serviceId,
    status: deployment.status,
  });
}

/**
 * Polls the container until it answers. Any HTTP response counts. A 404 still
 * proves something is listening. And a container that exits early fails fast with
 * its own output rather than after the full timeout.
 */
async function waitForHealthy(
  containerId: string,
  port: number,
  service: Service,
  log: DeploymentLog,
  signal: AbortSignal,
): Promise<void> {
  const inspected = await inspectContainer(containerId);
  const hostPort = Number(inspected?.NetworkSettings.Ports?.[`${port}/tcp`]?.[0]?.HostPort ?? 0);
  const healthPath = service.healthPath || '/';
  log.write(`Waiting for ${service.name} to answer on port ${port}…`);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Cancelled();

    const state = await inspectContainer(containerId);
    if (state && !state.State.Running && state.State.Status !== 'created') {
      const tail = await tailRuntimeLogs(containerId, log);
      throw new FriendlyError(
        state.State.OOMKilled
          ? `${service.name} ran out of memory as soon as it started.`
          : `${service.name} started and then stopped straight away (exit code ${state.State.ExitCode}).`,
        state.State.OOMKilled
          ? 'Give it a higher memory limit in Settings, or reduce what it loads at startup.'
          : 'The last lines of its output are above. They usually say what went wrong.',
        tail,
      );
    }

    if (hostPort > 0) {
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}${healthPath}`, {
          signal: AbortSignal.timeout(3000),
          redirect: 'manual',
        });
        log.write(`Answered with ${response.status}. Good enough.`);
        return;
      } catch {
        // not listening yet
      }
    }
    await Bun.sleep(500);
  }

  const tail = await tailRuntimeLogs(containerId, log);
  throw new FriendlyError(
    `${service.name} started, but never answered on port ${port}.`,
    `If your app listens on a different port, change it in Settings. Derailed also sets PORT=${port}, most frameworks use it automatically.`,
    tail,
  );
}

async function tailRuntimeLogs(containerId: string, log: DeploymentLog): Promise<string[]> {
  const lines: string[] = [];
  try {
    for await (const entry of streamContainerLogs(containerId, { tail: 30 })) {
      lines.push(entry.line);
      log.write(entry.line, 'runtime');
    }
  } catch {
    // the container may already be gone
  }
  return lines.slice(-12);
}

async function stopOldContainers(
  serviceId: string,
  keepDeploymentId: string,
  log: DeploymentLog,
): Promise<void> {
  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  for (const container of containers) {
    if (container.Labels?.[LABELS.deployment] === keepDeploymentId) continue;
    log.write('Stopping the previous version…');
    await destroyContainer(container.Id, OLD_CONTAINER_GRACE_S).catch(() => undefined);
  }
}

async function cleanupFailedContainer(deploymentId: string): Promise<void> {
  const containers = await listContainers(labelFilter({ [LABELS.deployment]: deploymentId })).catch(
    () => [],
  );
  for (const container of containers) {
    await destroyContainer(container.Id, 5).catch(() => undefined);
  }
}

/** Every app gets a working web address the moment it first goes live. */
function ensureGeneratedDomain(service: Service): void {
  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) return;
  const base = getSetting(SETTINGS.appBaseDomain);
  const hostname = generatedHostname(service.slug, serverIp, base);
  const existing = listDomains(service.id);
  if (existing.some((domain) => domain.hostname === hostname)) return;

  if (base) {
    // On a real domain the certificate is worth waiting for, so this starts unchecked
    // and the domain watcher promotes it as soon as DNS and the certificate are up.
    createDomain(service.id, hostname, 'generated', 'unchecked', 'pending');
    return;
  }
  // An sslip.io address is HTTP-only by design, so TLS is not "pending" forever.
  createDomain(service.id, hostname, 'generated', 'ok', 'disabled');
}

interface Explained {
  summary: string;
  hint?: string;
  detail?: string[];
}

/** Turns whatever went wrong into one sentence a person can act on. */
export function explain(err: unknown): Explained {
  if (err instanceof FriendlyError) {
    return { summary: err.message, hint: err.hint, detail: err.detail };
  }
  if (err instanceof BuildFailed) {
    return {
      summary: 'The build failed.',
      hint: 'The last lines of the build output are above. They usually name the file or package that broke.',
      detail: [err.message, ...err.tail],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/no space left on device/i.test(message)) {
    return {
      summary: 'This server ran out of disk space during the build.',
      hint: 'Free some space and try again. Old images are the usual culprit.',
    };
  }
  if (/could not reach docker/i.test(message)) {
    return {
      summary: 'Derailed lost contact with Docker part-way through.',
      hint: 'Check that the Docker service is running, then deploy again.',
    };
  }
  return {
    summary: 'Something went wrong during the deploy.',
    hint: 'The log above has the details.',
    detail: [message],
  };
}

/** Re-runs an old deployment's image without rebuilding it. */
export function canRollbackTo(deployment: Deployment | null): boolean {
  return !!deployment?.imageTag && deployment.status === 'superseded';
}

export { runningDeployment };

interface LaunchInput {
  job: Job;
  deployment: Deployment;
  service: Service;
  project: { id: string; slug: string };
  log: DeploymentLog;
  imageTag: string;
  port: number;
  runtimeEnv: Record<string, string>;
  step: (status: DeploymentStatus) => void;
}

/**
 * The half of a deploy that both a build and a rollback share: start the container,
 * wait for it to answer, point traffic at it, then retire the previous one. Routing
 * before retiring is what makes a redeploy effectively downtime-free.
 */
async function launch(input: LaunchInput): Promise<void> {
  const { job, deployment, service, project, log, imageTag, port, runtimeEnv, step } = input;

  step('starting');
  const network = await ensureProjectNetwork(project.id);
  await attachCaddyToNetwork(network);

  const name = containerName(project.slug, service.slug, deployment.id);

  // Each deploy gets a brand-new container, so anything the app wrote to its own
  // filesystem is gone. Volumes are what carry uploads, themes and databases across.
  const mounts = volumeMounts(service.id);
  for (const volumeName of Object.keys(mounts)) {
    await ensureVolume(volumeName, managedLabels({ serviceId: service.id, role: 'app' }));
  }
  if (Object.keys(mounts).length > 0) {
    log.write(`Keeping ${Object.values(mounts).join(', ')} across deploys.`);
  }

  log.write(`Starting ${service.name}…`);
  const containerId = await createContainer({
    name,
    image: imageTag,
    env: runtimeEnv,
    volumes: mounts,
    labels: managedLabels({
      projectId: project.id,
      serviceId: service.id,
      deploymentId: deployment.id,
      role: 'app',
    }),
    network,
    aliases: [service.slug, name],
    // Published on loopback only: lets Derailed health-check it and makes local
    // debugging possible without exposing anything to the internet.
    ports: { [port]: { host: '127.0.0.1', port: 0 } },
    memoryLimitMb: service.memoryLimitMb,
    restartPolicy: 'unless-stopped',
  });
  updateDeployment(deployment.id, { containerId, imageTag });
  await startContainer(containerId);

  step('checking');
  await waitForHealthy(containerId, port, service, log, job.cancel.signal);

  step('routing');
  ensureGeneratedDomain(service);
  const superseded = supersedePrevious(service.id, deployment.id);
  // Marked running before the routes are pushed, because route synthesis asks the
  // database which deployment is live. `finishedAt` is only set once the old
  // container is gone, so "finished" always means finished.
  updateDeployment(deployment.id, { status: 'running' });
  await syncRoutes();
  for (const id of superseded) {
    const old = findDeployment(id);
    if (old) emitDeployment(old);
  }

  await stopOldContainers(service.id, deployment.id, log);

  log.write(`${service.name} is live.`);
  finish(deployment.id, 'running');
}

/** Rollback: re-run a previous deployment's image, no clone and no build. */
/**
 * Deploying a ready-made image: WordPress, Ghost, n8n and friends. No repository, no
 * Dockerfile, no build, pull the image and run it, so the same start / health-check /
 * route / retire machinery applies as for anything else.
 */
async function runFromReadyImage(
  job: Job,
  deployment: Deployment,
  service: Service,
  project: { id: string; slug: string },
  log: DeploymentLog,
  step: (status: DeploymentStatus) => void,
): Promise<void> {
  const image = service.image!;

  step('building');
  if (await imageExists(image)) {
    log.write(`${image} is already on this server.`);
  } else {
    log.write(`Fetching ${image}…`);
    try {
      await pullImage(image, (line) => log.write(line, 'build'));
    } catch (err) {
      throw new FriendlyError(
        `Derailed couldn't fetch the image ${image}.`,
        'Check the name and tag are right, and that the image is public.',
        [err instanceof Error ? err.message : String(err)],
      );
    }
  }

  const port = resolvePort(service.port, null);
  const runtimeEnv = { ...envMap(service.id), PORT: String(port) };

  await launch({
    job,
    deployment,
    service,
    project,
    log,
    imageTag: image,
    port,
    runtimeEnv,
    step,
  });
}

async function runFromImage(
  job: Job,
  deployment: Deployment,
  service: Service,
  project: { id: string; slug: string },
  log: DeploymentLog,
): Promise<void> {
  const step = (status: DeploymentStatus) => {
    if (job.cancel.signal.aborted) throw new Cancelled();
    const updated = updateDeployment(deployment.id, { status });
    if (updated) emitDeployment(updated);
  };

  log.write(`Going back to the version from ${new Date(deployment.createdAt).toLocaleString()}…`);
  const port = resolvePort(service.port, null);
  const runtimeEnv = { ...envMap(service.id), PORT: String(port) };

  await launch({
    job,
    deployment,
    service,
    project,
    log,
    imageTag: job.reuseImage!,
    port,
    runtimeEnv,
    step,
  });
}

/**
 * Queues a rollback to an earlier deployment. The image is still on disk, so this is
 * a container restart rather than a rebuild, seconds, not minutes.
 */
export function queueRollback(deploymentId: string): Deployment {
  const previous = findDeployment(deploymentId);
  if (!previous?.imageTag) {
    throw new FriendlyError(
      "That version can't be brought back, its build is no longer on this server.",
      'Deploy from the repository instead.',
    );
  }
  return queueDeployment(previous.serviceId, 'rollback', previous.imageTag);
}
