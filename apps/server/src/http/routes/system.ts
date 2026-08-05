import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { paths } from '../../config.ts';
import { createDomain, findDomainByHostname, listDomains } from '../../db/repo/domains.ts';
import { listServices } from '../../db/repo/services.ts';
import { deleteSetting, getSetting, SETTINGS, setSetting } from '../../db/repo/settings.ts';
import { checkDns } from '../../proxy/dns.ts';
import { checkDomain } from '../../proxy/domainwatch.ts';
import { generatedHostname, isIpBasedHostname } from '../../proxy/routes.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { otherSoftware } from '../../system/others.ts';
import { serverStats } from '../../system/stats.ts';
import { detectServerIp, systemInfo } from '../../system/status.ts';
import { checkForUpdate } from '../../update.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, conflict, parseBody } from '../errors.ts';

export const systemRoutes = new Hono<AppEnv>();

systemRoutes.get('/', async (c) => c.json({ system: await systemInfo() }));

/** Asked for explicitly by the Settings page, never checked in the background. */
systemRoutes.get('/update', async (c) => c.json({ update: await checkForUpdate() }));

systemRoutes.get('/stats', async (c) => c.json({ stats: await serverStats() }));

/** Derailed itself, and whatever else someone put on this machine. */
systemRoutes.get('/others', async (c) => c.json({ others: await otherSoftware(paths.dataDir) }));

systemRoutes.get('/panel-domain', (c) =>
  c.json({ panelDomain: getSetting(SETTINGS.panelDomain) ?? null }),
);

/**
 * Puts the dashboard itself behind a domain with HTTPS.
 *
 * Until this is set the panel is only reachable over plain HTTP on its port, which
 * means the admin password crosses the wire in the clear.
 */
systemRoutes.put('/panel-domain', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { hostname?: string | null };
  const hostname = body.hostname?.trim().toLowerCase() || null;

  if (!hostname) {
    deleteSetting(SETTINGS.panelDomain);
    await syncRoutes();
    return c.json({ panelDomain: null });
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) {
    throw badRequest(
      `"${hostname}" doesn't look like a domain name.`,
      'Use something like dashboard.example.com.',
    );
  }
  if (isIpBasedHostname(hostname)) {
    throw badRequest(
      "The ready-made addresses can't be used for the dashboard.",
      'Use a domain you own, so it can be given a certificate.',
    );
  }
  if (findDomainByHostname(hostname)) {
    throw conflict(`${hostname} is already used by one of your apps.`);
  }

  // Same rule as any other domain: no route until DNS actually points here, or Caddy
  // asks Let's Encrypt for a certificate it can never be issued.
  const serverIp = getSetting(SETTINGS.serverIp);
  const check = serverIp ? await checkDns(hostname, serverIp) : null;
  if (check && check.status !== 'ok') {
    throw badRequest(
      check.status === 'wrong_ip'
        ? `${hostname} points somewhere else, not at this server.`
        : `${hostname} doesn't point anywhere yet.`,
      `Add an A record for ${hostname} pointing to ${serverIp}, then try again.`,
    );
  }

  setSetting(SETTINGS.panelDomain, hostname);
  await syncRoutes();
  return c.json({ panelDomain: hostname });
});

systemRoutes.get('/app-domain', (c) =>
  c.json({ appDomain: getSetting(SETTINGS.appBaseDomain) ?? null }),
);

/**
 * Puts the addresses Derailed hands out on a domain of your own.
 *
 * The ready-made sslip.io addresses can never be secured: sslip.io is not on the
 * public suffix list, so Let's Encrypt counts every address in the world under it
 * against one allowance of fifty certificates a week. Point a wildcard at this server
 * instead and every app gets its own name with a real padlock.
 */
systemRoutes.put('/app-domain', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { domain?: string | null };
  const domain = body.domain?.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '') || null;

  if (!domain) {
    deleteSetting(SETTINGS.appBaseDomain);
    return c.json({ appDomain: null });
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw badRequest(
      `"${domain}" doesn't look like a domain name.`,
      'Use something like apps.example.com.',
    );
  }
  if (isIpBasedHostname(domain)) {
    throw badRequest(
      'Those ready-made addresses cannot be secured, which is the reason for this setting.',
      'Use a domain you own.',
    );
  }

  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) {
    throw badRequest("Derailed doesn't know this server's address yet.", 'Set it just above.');
  }

  // Ask for a name nobody would ever create by hand. Only a wildcard record answers
  // it, which is exactly the thing that has to be in place before this is any use.
  const probe = `derailed-check-${Math.random().toString(36).slice(2, 8)}.${domain}`;
  const check = await checkDns(probe, serverIp);
  if (check.status !== 'ok') {
    throw badRequest(
      check.status === 'wrong_ip'
        ? `Names under ${domain} point somewhere else, not at this server.`
        : `There is no wildcard record for ${domain} yet.`,
      `At your domain provider, add an A record for *.${domain} pointing to ${serverIp}, then try again. It can take a few minutes to spread.`,
    );
  }

  setSetting(SETTINGS.appBaseDomain, domain);

  const added = await giveEveryAppAnAddress(domain, serverIp);
  await syncRoutes();
  return c.json({ appDomain: domain, added });
});

/**
 * Gives every app that is already live an address on the new domain.
 *
 * The old address is kept. Someone has almost certainly shared it by now, and taking
 * a working link away from them to tidy up a list is not a trade worth making.
 */
async function giveEveryAppAnAddress(domain: string, serverIp: string): Promise<number> {
  const fresh: string[] = [];
  for (const service of listServices()) {
    if (service.kind !== 'app') continue;
    // Only apps that have been live at least once: an address for something that has
    // never started would just be a link to a 404.
    if (!listDomains(service.id).length) continue;

    const hostname = generatedHostname(service.slug, serverIp, domain);
    if (findDomainByHostname(hostname)) continue;

    fresh.push(createDomain(service.id, hostname, 'generated', 'unchecked', 'pending').id);
  }

  // Check them now rather than waiting for the next sweep, so the padlock appears
  // while someone is still looking at the page they turned this on from.
  if (fresh.length) {
    void (async () => {
      for (const id of fresh) await checkDomain(id).catch(() => undefined);
      await syncRoutes().catch(() => undefined);
    })();
  }
  return fresh.length;
}

systemRoutes.patch('/', async (c) => {
  const { serverIp } = await parseBody(c, schemas.patchSystemRequest);
  if (serverIp === null) {
    deleteSetting(SETTINGS.serverIp);
    deleteSetting(SETTINGS.serverIpSource);
    await detectServerIp();
  } else if (serverIp !== undefined) {
    setSetting(SETTINGS.serverIp, serverIp);
    setSetting(SETTINGS.serverIpSource, 'manual');
  }
  return c.json({ system: await systemInfo() });
});
