import type { Domain } from '@derailed/shared';
import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { port as panelPort } from '../../config.ts';
import {
  allDomains,
  attachDomain,
  createDomain,
  deleteDomain,
  findDomain,
  findDomainByHostname,
  listDomains,
  setRedirect,
} from '../../db/repo/domains.ts';
import { listProjects } from '../../db/repo/projects.ts';
import { findService } from '../../db/repo/services.ts';
import { getSetting, SETTINGS } from '../../db/repo/settings.ts';
import { wwwVariant } from '../../proxy/dns.ts';
import { checkDomain } from '../../proxy/domainwatch.ts';
import { isIpBasedHostname } from '../../proxy/routes.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { emitService, presentService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, conflict, notFound, parseBody } from '../errors.ts';

export const serviceDomainRoutes = new Hono<AppEnv>();
export const domainRoutes = new Hono<AppEnv>();

/** Every domain on the server, whether or not an app answers on it yet. */
domainRoutes.get('/', (c) => {
  const projects = listProjects();
  const rows = allDomains().map((domain) => {
    const service = domain.serviceId ? findService(domain.serviceId) : null;
    const project = service ? projects.find((entry) => entry.id === service.projectId) : null;
    return {
      ...domain,
      serviceName: service?.name ?? null,
      serviceStatus: service ? presentService(service).status : null,
      projectName: project?.name ?? null,
      projectSlug: project?.slug ?? null,
    };
  });
  return c.json({ domains: rows });
});

/**
 * Adds a domain you own, without deciding yet what answers on it.
 *
 * Pointing a domain at a server and choosing which app uses it are two different
 * jobs, often days apart. Insisting on both at once meant the only way to add a
 * domain was to already have the app it belonged to.
 */
domainRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    hostname?: string;
    alsoAddWww?: boolean;
    /** Which of the pair people should see. The other redirects to it. */
    primary?: 'apex' | 'www';
    /**
     * An existing domain this new one should send people to.
     *
     * For adding the www half after the fact. Asking for the pair again is not the
     * same request: the apex already exists, so it would be refused as a duplicate.
     */
    redirectTo?: string;
  };

  const hostname = (body.hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!schemas.isHostname(hostname)) {
    throw badRequest(
      `"${body.hostname ?? ''}" doesn't look like a domain name.`,
      'Use something like example.com or shop.example.com.',
    );
  }

  const alsoAddWww = body.alsoAddWww === true;
  const www = wwwVariant(hostname);
  const pair = alsoAddWww && www ? [hostname, www] : [hostname];
  for (const candidate of pair) assertUsable(candidate);

  // Pairing with something that already exists: one new domain, pointed at it.
  if (body.redirectTo) {
    const target = findDomain(body.redirectTo);
    if (!target) throw badRequest('There is no domain here to send people to.');
    if (target.redirectTo) {
      throw badRequest(
        `${target.hostname} already sends people somewhere else.`,
        'Point the new one at the address people see instead.',
      );
    }
    // The redirect half answers on the same app, or the redirect has nothing to
    // serve and the visitor gets an error instead of a redirect.
    const made = createDomain(target.serviceId ?? null, hostname, 'custom');
    setRedirect(made.id, target.id);
    await checkDomain(made.id);
    return c.json({ domains: [findDomain(made.id)] }, 201);
  }

  const added = pair.map((candidate) => createDomain(null, candidate, 'custom'));

  // One of them is the address people see; the other only exists to send them there.
  if (added.length === 2) {
    const [apex, wwwDomain] = added as [Domain, Domain];
    if (body.primary === 'www') setRedirect(apex.id, wwwDomain.id);
    else setRedirect(wwwDomain.id, apex.id);
  }

  // Checked straight away, so the answer is "it points here" rather than "checking…".
  for (const domain of added) await checkDomain(domain.id);

  return c.json({ domains: added.map((domain) => findDomain(domain.id)) }, 201);
});

/** Swaps which half of a pair people see, and which one redirects. */
domainRoutes.put('/:id/primary', async (c) => {
  const domain = findDomain(c.req.param('id'));
  if (!domain) throw notFound('That domain');
  if (!domain.redirectTo) throw badRequest('That address is already the one people see.');

  const other = findDomain(domain.redirectTo);
  if (!other) throw notFound('The other half of that pair');

  // The service and the redirect swap together, or the pair would point nowhere.
  setRedirect(domain.id, null);
  setRedirect(other.id, domain.id);
  attachDomain(domain.id, other.serviceId);
  attachDomain(other.id, null);

  await syncRoutes();
  if (other.serviceId) emitService(other.serviceId);
  return c.json({ domain: findDomain(domain.id) });
});

/** Points a domain at one of your apps, or takes it back off. */
domainRoutes.put('/:id/service', async (c) => {
  const domain = findDomain(c.req.param('id'));
  if (!domain) throw notFound('That domain');
  if (domain.kind === 'generated') {
    throw badRequest('Automatic addresses always belong to the app they were made for.');
  }

  const body = (await c.req.json().catch(() => ({}))) as { serviceId?: string | null };
  const serviceId = body.serviceId ?? null;
  const previous = domain.serviceId;

  if (serviceId) {
    const service = findService(serviceId);
    if (!service) throw notFound('That app');
    if (service.kind !== 'app') {
      throw badRequest(
        "Databases don't get web addresses. They're reached from your apps, privately.",
      );
    }
  }

  const updated = attachDomain(domain.id, serviceId);
  await syncRoutes();
  if (serviceId) emitService(serviceId);
  if (previous && previous !== serviceId) emitService(previous);

  return c.json({ domain: updated });
});

/** POST /services/:id/domains, for adding one from inside an app. */
serviceDomainRoutes.post('/:id/domains', async (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That service');
  if (service.kind !== 'app') {
    throw badRequest(
      "Databases don't get web addresses. They're reached from your apps, privately.",
    );
  }

  const { hostname, alsoAddWww } = await parseBody(c, schemas.createDomainRequest);
  const wanted = [
    hostname,
    ...(alsoAddWww ? [wwwVariant(hostname)].filter(Boolean) : []),
  ] as string[];

  for (const candidate of wanted) assertUsable(candidate, service.id);

  for (const candidate of wanted) {
    // A domain already added but not yet in use is claimed rather than duplicated.
    const existing = findDomainByHostname(candidate);
    if (existing) attachDomain(existing.id, service.id);
    else createDomain(service.id, candidate, 'custom');
  }

  for (const domain of listDomains(service.id)) {
    if (domain.kind === 'custom' && domain.dnsStatus === 'unchecked') {
      await checkDomain(domain.id);
    }
  }
  await syncRoutes();
  emitService(service.id);

  return c.json({ domains: listDomains(service.id) }, 201);
});

domainRoutes.delete('/:id', async (c) => {
  const domain = findDomain(c.req.param('id'));
  if (!domain) throw notFound('That domain');
  if (domain.kind === 'generated') {
    throw badRequest(
      "An automatic address can't be removed.",
      'It disappears when you delete the app.',
    );
  }
  deleteDomain(domain.id);
  await syncRoutes();
  if (domain.serviceId) emitService(domain.serviceId);
  return c.json({ ok: true });
});

domainRoutes.post('/:id/check', async (c) => {
  const domain = findDomain(c.req.param('id'));
  if (!domain) throw notFound('That domain');
  const updated = await checkDomain(domain.id);
  if (updated?.dnsStatus === 'ok') await syncRoutes();
  return c.json({ domain: updated ?? domain });
});

/** Handy for the settings page: what the panel itself is reachable on. */
domainRoutes.get('/_panel', (c) =>
  c.json({
    serverIp: getSetting(SETTINGS.serverIp),
    port: panelPort,
  }),
);

/**
 * Whether this hostname can be added at all.
 *
 * `forService` is the app asking. A domain already sitting unused is fair game for it;
 * one in use by something else is not, and saying which app has it saves a hunt.
 */
function assertUsable(hostname: string, forService?: string): void {
  if (isIpBasedHostname(hostname)) {
    throw badRequest(
      'That address belongs to the automatic ones Derailed hands out.',
      'Use a domain you own.',
    );
  }

  const existing = findDomainByHostname(hostname);
  if (!existing) return;
  if (!existing.serviceId && forService) return;

  const owner = existing.serviceId ? findService(existing.serviceId) : null;
  throw conflict(
    !owner
      ? `${hostname} has already been added.`
      : owner.id === forService
        ? `${hostname} is already set up for this app.`
        : `${hostname} is already used by ${owner.name}.`,
  );
}
