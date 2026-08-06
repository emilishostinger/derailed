import { startTrafficCollector, stopTrafficCollector } from './analytics/collect.ts';
import { pruneTraffic } from './analytics/store.ts';
import { startDrills, stopDrills } from './backup/drill.ts';
import { startBackupSchedule, stopBackupSchedule } from './backup/schedule.ts';
import { startPushWatcher, stopPushWatcher } from './build/pushes.ts';
import { startReleaseWatcher, stopReleaseWatcher } from './build/releases.ts';
import { ensureDirs, host, isDev, paths, port, VERSION } from './config.ts';
import { initDb } from './db/index.ts';
import { pruneExpiredSessions } from './db/repo/sessions.ts';
import { publish } from './events/bus.ts';
import { createApp } from './http/app.ts';
import { isSameOrigin, userFromRequest } from './http/auth.ts';
import { socketHandlers } from './http/sockets.ts';
import { startUpdateNotifier, stopUpdateNotifier } from './mail/notify.ts';
import { ensureCaddyRunning, pingCaddy } from './proxy/caddy.ts';
import { startDomainWatcher, stopDomainWatcher } from './proxy/domainwatch.ts';
import { startFreeDomainRenewal, stopFreeDomainRenewal } from './proxy/freedomain.ts';
import { syncRoutes } from './proxy/sync.ts';
import {
  checkDiskSpace,
  pruneOldDeployments,
  pruneOrphanedNetworks,
} from './runtime/housekeeping.ts';
import { startMonitor, stopMonitor } from './runtime/monitor.ts';
import { startPreviews, stopPreviews } from './runtime/preview.ts';
import { reconcile } from './runtime/reconcile.ts';
import { startTrashSweep, stopTrashSweep } from './runtime/trash.ts';
import { diskReport } from './system/disk.ts';
import { detectServerIp, setCaddyHealthy, systemInfo } from './system/status.ts';
import { loadSecretKey } from './util/crypto.ts';

export async function serve(): Promise<void> {
  ensureDirs();
  initDb();
  loadSecretKey();
  pruneExpiredSessions();

  const app = createApp();

  const server = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 60,
    development: isDev,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/api/ws' || url.pathname === '/api/terminal') {
        // Before the cookie is even looked at: a socket opened by a page on another
        // origin is not the dashboard, whoever's cookie came with it.
        if (!isSameOrigin(request)) {
          return new Response('Not allowed from there', { status: 403 });
        }
      }

      if (url.pathname === '/api/ws') {
        const user = userFromRequest(request);
        if (!user) return new Response('Unauthorized', { status: 401 });
        const upgraded = server.upgrade(request, {
          data: { kind: 'events', userId: user.id, topics: new Set<string>() },
        });
        return upgraded ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
      }

      // A shell inside one of the containers Derailed manages.
      if (url.pathname === '/api/terminal') {
        const user = userFromRequest(request);
        if (!user) return new Response('Unauthorized', { status: 401 });
        const serviceId = url.searchParams.get('service');
        if (!serviceId) return new Response('Which service?', { status: 400 });
        const upgraded = server.upgrade(request, {
          data: { kind: 'terminal', userId: user.id, serviceId },
        });
        return upgraded ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      return app.fetch(request, { ip: server.requestIP(request) });
    },
    websocket: socketHandlers,
  });

  // Background housekeeping.
  const systemTicker = setInterval(async () => {
    publish('system', { type: 'system', system: await systemInfo() });
  }, 15_000);
  const sessionTicker = setInterval(pruneExpiredSessions, 60 * 60 * 1000);
  const pruneTicker = setInterval(
    () => {
      void pruneOldDeployments().catch(() => undefined);
    },
    6 * 60 * 60 * 1000,
  );
  // Nag once a day at most if the disk is filling up, so it's noticed before a
  // deploy fails because of it.
  const diskTicker = setInterval(
    async () => {
      // Two ways of being short of room, and both matter. An absolute floor catches
      // the small disk with no space for a build; a percentage catches the large one
      // filling steadily, which the floor would not notice until it was far too late.
      const disk = await checkDiskSpace().catch(() => null);
      const report = await diskReport().catch(() => null);

      if (disk && !disk.ok) {
        publish('system', {
          type: 'notice',
          level: 'warn',
          message: `${disk.message} ${disk.hint ?? ''}`.trim(),
        });
      } else if (report && report.level !== 'ok') {
        publish('system', {
          type: 'notice',
          level: report.level === 'full' ? 'error' : 'warn',
          message:
            report.reclaimableBytes > 0
              ? `${report.summary} Open the Server page to tidy up.`
              : report.summary,
        });
      }
    },
    60 * 60 * 1000,
  );
  const caddyTicker = setInterval(async () => {
    setCaddyHealthy(await pingCaddy());
  }, 20_000);
  for (const ticker of [systemTicker, sessionTicker, caddyTicker, pruneTicker, diskTicker]) {
    ticker.unref?.();
  }

  const ip = await detectServerIp();
  // The dashboard must come up even when Docker is broken. That is exactly when
  // someone needs to read the error message.
  void bootRuntime();

  console.log(`\n  Derailed ${VERSION}`);
  console.log(`  Dashboard  →  http://${ip ?? 'localhost'}:${server.port}`);
  console.log(`  Data       →  ${paths.dataDir}`);
  const info = await systemInfo();
  if (!info.dockerOk) {
    console.log(`  Docker     →  unreachable: ${info.dockerError}`);
  } else {
    console.log(`  Docker     →  ${info.dockerVersion}`);
  }
  if (!info.setupComplete) {
    console.log('\n  Open the dashboard to create your account.\n');
  } else {
    console.log('');
  }

  const shutdown = () => {
    console.log('\nShutting down.');
    stopDomainWatcher();
    stopFreeDomainRenewal();
    stopBackupSchedule();
    stopDrills();
    stopTrashSweep();
    stopPreviews();
    stopReleaseWatcher();
    stopPushWatcher();
    stopUpdateNotifier();
    stopTrafficCollector();
    stopMonitor();
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Someone's website should not go down because a background poller hit a value it
  // did not expect. Log it loudly and carry on: the alternative is that a stray null
  // in a stats sample takes every app on the machine offline with it.
  process.on('uncaughtException', (err) => {
    console.error('Unexpected error, carrying on:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unexpected error, carrying on:', reason);
  });
}

/**
 * Everything that needs Docker. Runs after the HTTP server is already listening so
 * a broken Docker install shows up in the dashboard instead of blocking boot.
 */
async function bootRuntime(): Promise<void> {
  const info = await systemInfo();
  if (!info.dockerOk) {
    publish('system', {
      type: 'notice',
      level: 'error',
      message: "Derailed can't reach Docker, so it can't run anything yet.",
    });
    return;
  }

  startMonitor();

  try {
    await ensureCaddyRunning((line) => console.log(`  caddy      →  ${line}`));

    const report = await reconcile();
    for (const name of report.started) console.log(`  restarted  →  ${name}`);
    for (const name of report.markedStopped)
      console.log(`  stopped    →  ${name} (container gone)`);
    for (const name of report.removed) console.log(`  cleaned up →  ${name}`);
    for (const problem of report.problems) console.warn(`  problem    →  ${problem}`);

    startDomainWatcher();
    // Renewing pushes a fresh certificate to Caddy, which only matters once Caddy is
    // up, hence its place here rather than beside the other timers.
    startFreeDomainRenewal(() => syncRoutes());
    startBackupSchedule();
    startDrills((line) => console.log(`  backups    →  ${line}`));
    startTrashSweep((line) => console.log(`  trash      →  ${line}`));
    startPreviews();
    startReleaseWatcher();
    startPushWatcher();
    startUpdateNotifier();
    startTrafficCollector();
    pruneTraffic();

    // Old build logs and images are the main way a small VPS fills up.
    // Docker's address pool is small and project networks outlive their projects when
    // something goes wrong. Exhausting it breaks every future deploy on a machine that
    // otherwise looks fine, so this runs at every boot.
    const orphaned = await pruneOrphanedNetworks().catch(() => []);
    if (orphaned.length) console.log(`  cleaned up →  ${orphaned.length} unused project networks`);

    const pruned = await pruneOldDeployments();
    if (pruned.deploymentsRemoved > 0) {
      console.log(
        `  pruned     →  ${pruned.deploymentsRemoved} old deploys, ${pruned.imagesRemoved} images`,
      );
    }
  } catch (err) {
    console.error(
      `  caddy      →  could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
    publish('system', {
      type: 'notice',
      level: 'error',
      message:
        "The web traffic router didn't start, so your apps aren't reachable from the internet yet.",
    });
  }

  publish('system', { type: 'system', system: await systemInfo() });
}
