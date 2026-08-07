import type { Domain } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { caddy as caddyConfig } from '../config.ts';
import { allDomains, findDomain, updateDomainStatus } from '../db/repo/domains.ts';
import { findService } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { publishAll } from '../events/bus.ts';
import { checkDns, checkHttps } from './dns.ts';
import { isIpBasedHostname } from './routes.ts';
import { syncRoutes } from './sync.ts';

const INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Keeps custom domains honest: re-checks DNS until it points here, pushes the route
 * the moment it does, then watches for the certificate to go live. The UI never
 * polls. It just listens.
 */
export function startDomainWatcher(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref?.();
  void sweep();
}

export function stopDomainWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function sweep(): Promise<void> {
  const pending = allDomains().filter(
    (domain) =>
      !isIpBasedHostname(domain.hostname) &&
      (domain.dnsStatus !== 'ok' || domain.tlsStatus !== 'active'),
  );
  if (!pending.length) return;

  let routesNeedPushing = false;
  for (const domain of pending) {
    const before = { dns: domain.dnsStatus, tls: domain.tlsStatus };
    const updated = await checkDomain(domain.id);
    if (!updated) continue;
    if (updated.dnsStatus !== before.dns && updated.dnsStatus === 'ok') routesNeedPushing = true;
  }
  if (routesNeedPushing) await syncRoutes();
}

/** Runs one check and broadcasts the result. */
export async function checkDomain(domainId: string): Promise<Domain | null> {
  const domain = findDomain(domainId);
  if (!domain) return null;

  if (isIpBasedHostname(domain.hostname)) {
    return updateDomainStatus(domain.id, { dnsStatus: 'ok', tlsStatus: 'disabled', checked: true });
  }

  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) return domain;

  const dns = await checkDns(domain.hostname, serverIp);
  let tlsStatus = domain.tlsStatus;

  if (dns.status === 'ok') {
    // Only worth asking once traffic can actually reach us.
    const secure = await checkHttps(domain.hostname, caddyConfig.httpsPort);
    tlsStatus = secure ? 'active' : 'pending';
  } else {
    tlsStatus = 'pending';
  }

  const updated = updateDomainStatus(domain.id, {
    dnsStatus: dns.status,
    tlsStatus,
    checked: true,
  });
  if (!updated) return null;

  const service = updated.serviceId ? findService(updated.serviceId) : null;
  const relevant = updated.serviceId ? [topics.service(updated.serviceId)] : ['system'];
  if (service) relevant.push(topics.project(service.projectId));
  publishAll(relevant, { type: 'domain.updated', domain: updated });

  announce(domain, updated);
  return updated;
}

/**
 * Says so, once, when a domain starts working.
 *
 * Setting up a domain means going away to somebody else's website, changing a record,
 * and coming back not knowing whether it has taken. The card updates itself, but only
 * if you are looking at it, and the wait is anything from a minute to a day. These are
 * the two moments worth interrupting for, and each is announced on the transition
 * rather than on the state, so a server that has been up for a month is silent.
 */
export function announce(before: Domain, after: Domain): void {
  if (before.dnsStatus !== 'ok' && after.dnsStatus === 'ok') {
    publishAll(['system'], {
      type: 'notice',
      level: 'info',
      message: `${after.hostname} now points at this server. Sorting out its certificate.`,
    });
  }
  if (before.tlsStatus !== 'active' && after.tlsStatus === 'active') {
    publishAll(['system'], {
      type: 'notice',
      level: 'info',
      message: `${after.hostname} is live, with a padlock.`,
    });
  }
}
