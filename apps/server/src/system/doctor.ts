import type { DoctorCheck, DoctorReport } from '@derailed/shared';
import { listBackups } from '../backup/backup.ts';
import { allDomains } from '../db/repo/domains.ts';
import { listProjects } from '../db/repo/projects.ts';
import { listServices } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { certificateExpiry } from '../proxy/acme.ts';
import { pingCaddy } from '../proxy/caddy.ts';
import { freeDomainName } from '../proxy/freedomain.ts';
import { MIN_FREE_BYTES } from '../runtime/housekeeping.ts';
import { diskReport, formatBytes } from './disk.ts';
import { serverStats } from './stats.ts';
import { systemInfo } from './status.ts';
import { swapState } from './swap.ts';

/**
 * One button that checks everything.
 *
 * The point is not the checks, which are mostly things shown elsewhere. The point is
 * that when something is wrong there is one place to go, and every line either says
 * "fine" or says what to do about it. A dashboard full of green ticks is also worth
 * something on the day you are convinced the server is broken and it is not.
 *
 * Everything here is checked from inside the machine. Derailed deliberately does not
 * ask a third party whether your ports are open, because that would mean telling a
 * stranger your address every time you pressed the button.
 */

type Check = () => Promise<DoctorCheck>;

function ok(id: string, title: string, detail: string): DoctorCheck {
  return { id, title, status: 'ok', detail };
}

function warn(id: string, title: string, detail: string, fix?: DoctorCheck['fix']): DoctorCheck {
  return { id, title, status: 'warn', detail, fix };
}

function bad(id: string, title: string, detail: string, fix?: DoctorCheck['fix']): DoctorCheck {
  return { id, title, status: 'bad', detail, fix };
}

const checkDocker: Check = async () => {
  const info = await systemInfo();
  if (!info.dockerOk) {
    return bad(
      'docker',
      'Docker',
      info.dockerError ?? "Derailed can't reach Docker, so nothing can run.",
    );
  }
  return ok('docker', 'Docker', `Running, version ${info.dockerVersion}.`);
};

const checkProxy: Check = async () => {
  if (await pingCaddy()) {
    return ok('proxy', 'Web traffic router', 'Running and answering.');
  }
  return bad(
    'proxy',
    'Web traffic router',
    'The router is not answering, so none of your sites are reachable from the internet.',
    { action: 'restart-proxy', label: 'Start it again' },
  );
};

const checkDisk: Check = async () => {
  const report = await diskReport();
  const fix =
    report.reclaimableBytes > 0
      ? ({
          action: 'reclaim-disk',
          label: `Free up ${formatBytes(report.reclaimableBytes)}`,
        } as const)
      : undefined;

  if (report.freeBytes < MIN_FREE_BYTES) {
    return bad(
      'disk',
      'Disk space',
      `Only ${formatBytes(report.freeBytes)} left, which is not enough to build an app.`,
      fix,
    );
  }
  if (report.level !== 'ok') return warn('disk', 'Disk space', report.summary, fix);
  return ok('disk', 'Disk space', report.summary);
};

const checkMemory: Check = async () => {
  const stats = await serverStats();
  const percent = stats.memory.percent;

  // Only Linux gives a figure worth acting on. Elsewhere the "free" number leaves out
  // everything the kernel is holding as reclaimable cache, so a perfectly healthy Mac
  // reports 100% and the check cries wolf on the one machine nobody is worried about.
  if (process.platform !== 'linux') {
    return ok(
      'memory',
      'Memory',
      `${percent}% in use, though this is only meaningful on a server.`,
    );
  }

  if (percent >= 92) {
    return warn(
      'memory',
      'Memory',
      `${percent}% in use. When this runs out the system kills whichever app is using the most.`,
    );
  }
  return ok('memory', 'Memory', `${percent}% in use.`);
};

const checkSwap: Check = async () => {
  const swap = await swapState();
  if (swap.recommended) {
    return warn('swap', 'Swap', swap.reason ?? 'This server has no swap.', {
      action: 'add-swap',
      label: `Add ${formatBytes(swap.suggestedBytes)}`,
    });
  }
  if (swap.bytes === 0)
    return ok('swap', 'Swap', 'None, and this server has enough memory to do without.');
  return ok('swap', 'Swap', `${formatBytes(swap.bytes)} available.`);
};

/**
 * A clock that has drifted breaks certificate issuance and validation, and the error
 * you get says nothing about time. Compared against a header from an ordinary HTTPS
 * request rather than reaching for NTP, so it costs nothing extra.
 */
const checkClock: Check = async () => {
  try {
    const response = await fetch('https://api.ipify.org', {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
    });
    const header = response.headers.get('date');
    if (!header) return ok('clock', 'Clock', 'Could not check, which is not a problem in itself.');

    const skewSeconds = Math.abs(Date.now() - new Date(header).getTime()) / 1000;
    if (skewSeconds > 120) {
      return bad(
        'clock',
        'Clock',
        `This server's clock is ${Math.round(skewSeconds)} seconds out. Certificates will fail to issue and may fail to validate.`,
      );
    }
    return ok('clock', 'Clock', 'Correct.');
  } catch {
    return ok('clock', 'Clock', 'Could not check just now.');
  }
};

const checkDomains: Check = async () => {
  const domains = allDomains().filter((domain) => domain.kind === 'custom');
  if (!domains.length) return ok('domains', 'Your domains', 'None added yet.');

  const wrong = domains.filter((domain) => domain.dnsStatus === 'wrong_ip');
  const missing = domains.filter((domain) => domain.dnsStatus === 'no_record');

  if (wrong.length) {
    return bad(
      'domains',
      'Your domains',
      `${wrong.map((domain) => domain.hostname).join(', ')} ${wrong.length === 1 ? 'points' : 'point'} somewhere other than this server.`,
    );
  }
  if (missing.length) {
    return warn(
      'domains',
      'Your domains',
      `${missing.map((domain) => domain.hostname).join(', ')} ${missing.length === 1 ? 'does not point' : 'do not point'} anywhere yet.`,
    );
  }
  return ok('domains', 'Your domains', `All ${domains.length} pointing here.`);
};

const checkCertificates: Check = async () => {
  const name = freeDomainName();
  if (!name) {
    const secured = allDomains().filter((domain) => domain.tlsStatus === 'active').length;
    const failed = allDomains().filter((domain) => domain.tlsStatus === 'error');
    if (failed.length) {
      return warn(
        'certificates',
        'Certificates',
        `${failed.map((domain) => domain.hostname).join(', ')} could not be secured.`,
      );
    }
    return ok(
      'certificates',
      'Certificates',
      secured ? `${secured} in place.` : 'None needed yet.',
    );
  }

  const expiry = await certificateExpiry(name);
  if (expiry === null) {
    return warn('certificates', 'Certificates', `No certificate yet for ${name}.duckdns.org.`);
  }
  const days = Math.round((expiry - Date.now()) / 86_400_000);
  if (days < 0) return bad('certificates', 'Certificates', 'The certificate has expired.');
  if (days < 10) {
    return warn(
      'certificates',
      'Certificates',
      `Expires in ${days} days and has not renewed yet. Derailed keeps trying twice a day.`,
    );
  }
  return ok('certificates', 'Certificates', `Good for another ${days} days, renewing on its own.`);
};

const checkBackups: Check = async () => {
  const projects = listProjects();
  if (!projects.length) return ok('backups', 'Backups', 'Nothing to back up yet.');

  const scheduled = projects.filter((project) => project.backupSchedule !== 'off');
  if (!scheduled.length) {
    return warn(
      'backups',
      'Backups',
      'No project is being backed up. If this server died today, everything on it would go with it.',
    );
  }

  const copies = await listBackups().catch(() => []);
  if (!copies.length) {
    return warn(
      'backups',
      'Backups',
      `${scheduled.length} ${scheduled.length === 1 ? 'project is' : 'projects are'} scheduled, but nothing has been backed up yet.`,
    );
  }

  const newest = Math.max(...copies.map((copy) => copy.createdAt));
  const days = Math.round((Date.now() - newest) / 86_400_000);
  if (days > 8) {
    return warn('backups', 'Backups', `The newest backup is ${days} days old.`);
  }
  return ok(
    'backups',
    'Backups',
    `${copies.length} kept, newest ${days === 0 ? 'today' : `${days} days ago`}.`,
  );
};

const checkDashboardAddress: Check = async () => {
  if (getSetting(SETTINGS.panelDomain)) {
    return ok('panel', 'Dashboard address', 'Behind a domain, so sign-in is encrypted.');
  }
  return warn(
    'panel',
    'Dashboard address',
    'The dashboard is served over plain HTTP, so your password crosses the internet unencrypted every time you sign in.',
  );
};

const checkApps: Check = async () => {
  const services = listServices().filter((service) => service.kind === 'app');
  if (!services.length) return ok('apps', 'Your apps', 'None yet.');
  const stopped = services.filter((service) => service.instancesDesired === 1).length;
  return ok('apps', 'Your apps', `${services.length} set up, ${stopped} meant to be running.`);
};

const CHECKS: Check[] = [
  checkDocker,
  checkProxy,
  checkDisk,
  checkMemory,
  checkSwap,
  checkClock,
  checkDomains,
  checkCertificates,
  checkBackups,
  checkDashboardAddress,
  checkApps,
];

export async function runDoctor(): Promise<DoctorReport> {
  // In parallel, and the order of CHECKS is preserved because `Promise.all` resolves
  // positionally. Run one after another, the whole report waited on the slowest check
  // plus every other check, and the clock check alone talks to the network.
  const checks = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        return await check();
      } catch (err) {
        // A check that throws is a bug in the check, not a fault on the server.
        // Saying so beats a doctor that refuses to produce a report at all.
        return {
          id: 'unknown',
          title: 'A check failed to run',
          status: 'warn',
          detail: err instanceof Error ? err.message : String(err),
        } satisfies DoctorCheck;
      }
    }),
  );

  const bad = checks.filter((check) => check.status === 'bad').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;

  return {
    at: Date.now(),
    checks,
    summary:
      bad > 0
        ? `${bad} thing${bad === 1 ? '' : 's'} needs attention.`
        : warnings > 0
          ? `Everything works. ${warnings} thing${warnings === 1 ? '' : 's'} could be better.`
          : 'Everything looks right.',
    level: bad > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok',
  };
}
