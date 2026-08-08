import { topics } from '@derailed/shared';
import { resolvePort } from '../build/detect.ts';
import { port as panelPort } from '../config.ts';
import { runningDeployment } from '../db/repo/deployments.ts';
import { allDomains } from '../db/repo/domains.ts';
import { findProject } from '../db/repo/projects.ts';
import { accessFor, containerName, findService } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { publish } from '../events/bus.ts';
import { wallsFor } from './botguard.ts';
import { buildCaddyConfig, HOST_GATEWAY, pushCaddyConfig } from './caddy.ts';
import { isCoveredByFreeDomain, loadedCertificates } from './freedomain.ts';
import { isIpBasedHostname, type RouteSpec } from './routes.ts';

/**
 * Reads the whole world from the database and turns it into the set of routes Caddy
 * should be serving. A domain only makes it in when there is something to send
 * traffic to, otherwise visitors would get a confusing 502 instead of our 404.
 */
export function currentRoutes(): RouteSpec[] {
  const routes: RouteSpec[] = [];

  const domains = allDomains();
  const byId = new Map(domains.map((domain) => [domain.id, domain]));

  for (const domain of domains) {
    // Half of a pair: it serves nothing itself, it sends people to the other name.
    // Routed on its own merits, so it can hold a certificate and redirect over https.
    if (domain.redirectTo) {
      const target = byId.get(domain.redirectTo);
      if (!target || domain.dnsStatus !== 'ok') continue;
      routes.push({
        hostname: domain.hostname,
        upstream: '',
        port: 0,
        https: true,
        redirectTo: target.hostname,
      });
      continue;
    }

    // A domain nobody has pointed at an app yet is checked but not served.
    if (!domain.serviceId) continue;
    const service = findService(domain.serviceId);
    if (service?.kind !== 'app') continue;

    const deployment = runningDeployment(service.id);
    if (!deployment) continue;

    const project = findProject(service.projectId);
    if (!project) continue;

    // Anything that will be given a certificate is only routed once DNS actually
    // points here, or Caddy asks Let's Encrypt for one it can never get.
    //
    // Names under the free address are the exception: they are already covered by a
    // wildcard Derailed holds, so there is nothing to ask for and nothing to wait on.
    // DuckDNS answers every name under the claimed one from the moment it is claimed,
    // so holding these back for a DNS check would delay a padlock that already works.
    const ipBased = isIpBasedHostname(domain.hostname);
    const free = isCoveredByFreeDomain(domain.hostname);
    if (!ipBased && !free && domain.dnsStatus !== 'ok') continue;

    const auth = accessFor(service.id);
    routes.push({
      hostname: domain.hostname,
      upstream: containerName(project.slug, service.slug, deployment.id),
      port: resolvePort(service.port, null),
      https: !ipBased,
      providedCert: free,
      pathPrefix: domain.pathPrefix ?? null,
      // Enforced by the proxy rather than the app, which is what makes it work for
      // WordPress, a folder of HTML and anything else without touching any of them.
      access: {
        basicAuth: auth,
        allowFrom: service.access?.allowFrom ?? null,
        blockFrom: service.access?.blockFrom ?? null,
        maintenance: service.access?.maintenance ?? false,
      },
      // The POST a static site could never answer becomes a message instead.
      forms: service.forms
        ? { serviceId: service.id, panelUpstream: HOST_GATEWAY, panelPort }
        : null,
      // The walls against automated traffic, when this app asked for any.
      bots:
        service.botMode !== 'off' || service.blockAi
          ? {
              serviceId: service.id,
              blockAi: !!service.blockAi,
              ...wallsFor(service.id),
              panelUpstream: HOST_GATEWAY,
              panelPort,
            }
          : null,
    });
  }

  // The dashboard itself, if it has been given a domain. It runs on the host rather
  // than in a container, so Caddy reaches it back through the host gateway. Serving
  // the admin panel over plain HTTP means the password crosses the wire in the clear,
  // which is the whole reason this exists.
  const panel = getSetting(SETTINGS.panelDomain);
  if (panel) {
    routes.push({
      hostname: panel,
      upstream: HOST_GATEWAY,
      port: panelPort,
      https: true,
      providedCert: isCoveredByFreeDomain(panel),
    });
  }

  return routes;
}

let pending: Promise<void> | null = null;

/**
 * Pushes the full config. Calls that arrive while a push is in flight are coalesced
 * into one follow-up push, so a burst of changes never queues a burst of reloads.
 */
export async function syncRoutes(): Promise<void> {
  if (pending) return pending;

  pending = (async () => {
    try {
      await pushCaddyConfig(buildCaddyConfig(currentRoutes(), await loadedCertificates()));
    } catch (err) {
      publish(topics.system, {
        type: 'notice',
        level: 'error',
        message:
          err instanceof Error
            ? err.message
            : "Derailed couldn't update your web addresses just now.",
      });
    }
  })().finally(() => {
    pending = null;
  });

  return pending;
}
