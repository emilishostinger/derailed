import { topics } from '@derailed/shared';
import { resolvePort } from '../build/detect.ts';
import { port as panelPort } from '../config.ts';
import { runningDeployment } from '../db/repo/deployments.ts';
import { allDomains } from '../db/repo/domains.ts';
import { findProject } from '../db/repo/projects.ts';
import { accessFor, containerName, findService } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { publish } from '../events/bus.ts';
import { proxySecret } from '../http/proxytrust.ts';
import { isTailnetHostname } from '../system/tailscale.ts';
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
    // A tailnet name never has public DNS to check: Tailscale answers it for the
    // devices that may see it, and Funnel answers it for everyone else. TLS is
    // terminated by tailscaled with its own certificate, so Caddy serves these
    // over its plain listener the way it serves sslip.io names.
    const tailnet = isTailnetHostname(domain.hostname);
    if (!ipBased && !free && !tailnet && domain.dnsStatus !== 'ok') continue;

    const auth = accessFor(service.id);
    routes.push({
      hostname: domain.hostname,
      upstream: containerName(project.slug, service.slug, deployment.id),
      port: resolvePort(service.port, null),
      https: !ipBased && !tailnet,
      providedCert: free,
      pathPrefix: domain.pathPrefix ?? null,
      // The grown-up door, when it is on: individual accounts instead of the
      // shared password, which it replaces rather than stacks on.
      login: service.loginRequired
        ? { serviceId: service.id, panelUpstream: HOST_GATEWAY, panelPort }
        : null,
      // Enforced by the proxy rather than the app, which is what makes it work for
      // WordPress, a folder of HTML and anything else without touching any of them.
      access: {
        basicAuth: service.loginRequired ? null : auth,
        allowFrom: service.access?.allowFrom ?? null,
        blockFrom: service.access?.blockFrom ?? null,
        maintenance: service.access?.maintenance ?? false,
      },
      // Stamped on the internal routes that reach a public endpoint, so a
      // request straight to the panel's open port cannot pretend to be proxied.
      panelSecret: proxySecret(),
      // The POST a static site could never answer becomes a message instead. A
      // PHP site answers its own POSTs, so catching every one would divert its
      // contact form, its login, its admin: the framework tag is how a detected
      // PHP app is told apart from the static folders forms are actually for.
      forms:
        service.forms && service.framework !== 'PHP site'
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
let again = false;

async function pushOnce(): Promise<void> {
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
}

/**
 * Pushes the full config. A call that arrives while a push is in flight sets a
 * flag rather than queueing, so a burst of changes collapses to exactly one
 * follow-up push, and, crucially, a change made *during* a push is not lost: the
 * config is read fresh at the start of each push, and the flag guarantees one
 * more read after the last change lands.
 */
export async function syncRoutes(): Promise<void> {
  if (pending) {
    again = true;
    return pending;
  }

  pending = (async () => {
    await pushOnce();
    while (again) {
      again = false;
      await pushOnce();
    }
  })().finally(() => {
    pending = null;
  });

  return pending;
}
