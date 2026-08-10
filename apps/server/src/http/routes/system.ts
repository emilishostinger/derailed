import { type FreeDomainStep, schemas, topics } from '@derailed/shared';
import { Hono } from 'hono';
import { trafficAcrossServer } from '../../analytics/store.ts';
import { AdoptError, adopt, adoptable } from '../../catalog/adopt.ts';
import { paths } from '../../config.ts';
import { createDomain, findDomainByHostname, listDomains } from '../../db/repo/domains.ts';
import { listServices } from '../../db/repo/services.ts';
import {
  deleteSetting,
  getSetting,
  SETTINGS,
  setBoolSetting,
  setSetting,
} from '../../db/repo/settings.ts';
import { publish } from '../../events/bus.ts';
import { ensureCaddyRunning } from '../../proxy/caddy.ts';
import {
  DnsProviderError,
  hasDnsToken,
  listZones,
  setDnsToken,
  writeRecordsFor,
} from '../../proxy/clouddns.ts';
import { checkDns } from '../../proxy/dns.ts';
import { checkDomain } from '../../proxy/domainwatch.ts';
import {
  claimFreeDomain,
  FreeDomainError,
  freeDomainState,
  isCoveredByFreeDomain,
  releaseFreeDomain,
} from '../../proxy/freedomain.ts';
import { generatedHostname, isIpBasedHostname } from '../../proxy/routes.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import { recentLogs } from '../../runtime/logtail.ts';
import { previewShotsEnabled } from '../../runtime/preview.ts';
import { costComparison } from '../../system/cost.ts';
import { diskReport, freeUpSpace } from '../../system/disk.ts';
import { runDoctor } from '../../system/doctor.ts';
import { openPorts } from '../../system/firewall.ts';
import { otherSoftware } from '../../system/others.ts';
import { lastScan, runScan } from '../../system/scan.ts';
import {
  addKey,
  canManage,
  listKeys,
  passwordLoginState,
  removeKey,
  SshError,
  setPasswordLogin,
} from '../../system/ssh.ts';
import { serverStats } from '../../system/stats.ts';
import { detectServerIp, systemInfo } from '../../system/status.ts';
import { addSwap, SwapError, swapState } from '../../system/swap.ts';
import { checkForUpdate } from '../../update.ts';
import { type AppEnv, clientIp } from '../auth.ts';
import { badRequest, conflict, parseBody, readBody } from '../errors.ts';

export const systemRoutes = new Hono<AppEnv>();

systemRoutes.get('/', async (c) => c.json({ system: await systemInfo() }));

/** Asked for explicitly by the Settings page, never checked in the background. */
systemRoutes.get('/update', async (c) => c.json({ update: await checkForUpdate() }));

systemRoutes.get('/stats', async (c) => c.json({ stats: await serverStats() }));

/**
 * The address you are reading this from.
 *
 * Exists so the address list can have an "add mine" button. Everybody knows they want
 * "only me", and almost nobody knows their own public address; the honest ways to find
 * out are a search engine and a third-party site, and asking the server you are already
 * talking to is both easier and more private than either.
 */
systemRoutes.get('/my-address', (c) => c.json({ address: clientIp(c) }));

/**
 * Things already on this machine that Derailed could take over.
 *
 * Adopting is shallow on purpose: the container is left exactly as it was found and
 * gains an address, a certificate and a place in the topology. Derailed does not
 * learn how to rebuild it, and says so.
 */
systemRoutes.get('/adoptable', async (c) => c.json({ containers: await adoptable() }));

systemRoutes.post('/adopt', async (c) => {
  const body = (await readBody(c)) as {
    containerId?: string;
    projectName?: string;
    appName?: string;
    port?: number;
  };
  if (!body.containerId) throw badRequest('Which container?');

  try {
    return c.json(await adopt(body.containerId, body));
  } catch (err) {
    if (err instanceof AdoptError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

systemRoutes.get('/cost', (c) => c.json({ cost: costComparison() }));

/**
 * All the traffic on this machine, added up.
 *
 * "Is the server busy" is a different question from "how is this app doing", and
 * answering it meant opening every app in turn and adding up by eye.
 */
systemRoutes.get('/traffic', (c) => {
  const asked = c.req.query('range') ?? '24h';
  const range = asked === '7d' || asked === '30d' ? asked : '24h';

  // Scoped to one project when asked. The ids come from that project's own rows, so
  // nothing typed reaches the query.
  const projectId = c.req.query('project');
  const serviceId = c.req.query('service');
  const services = listServices();

  const scope = serviceId
    ? services.filter((service) => service.id === serviceId).map((service) => service.id)
    : projectId
      ? services
          .filter((service) => service.projectId === projectId && service.kind === 'app')
          .map((service) => service.id)
      : undefined;

  const report = trafficAcrossServer(range, scope);
  const named = new Map(services.map((service) => [service.id, service.name]));

  return c.json({
    traffic: {
      ...report,
      byService: report.byService
        .filter((row) => named.has(row.serviceId))
        .map((row) => ({ ...row, name: named.get(row.serviceId) })),
    },
  });
});

systemRoutes.get('/previews', (c) => c.json({ screenshots: previewShotsEnabled() }));

/**
 * Screenshots are on unless turned off. The first capture pulls a browser image of a
 * few hundred megabytes, which is a real cost, but the screenshot is also the moment
 * the dashboard proves an app actually loads: worth a one-time download by default,
 * and the Settings toggle is right there for a small disk.
 */
systemRoutes.put('/previews', async (c) => {
  const body = (await readBody(c)) as { screenshots?: boolean };
  setBoolSetting(SETTINGS.previewShots, body.screenshots === true);
  return c.json({ screenshots: previewShotsEnabled() });
});

systemRoutes.get('/doctor', async (c) => c.json({ report: await runDoctor() }));

/**
 * Is anything leaking or known-broken?
 *
 * The GET answers from the last run rather than scanning on the way in, because a
 * scan clones repositories and can take a minute; a page load should not. The POST
 * is the honest button: run it now, wait, get the report.
 */
systemRoutes.get('/scan', (c) => c.json({ scan: lastScan() }));

systemRoutes.post('/scan', async (c) => c.json({ scan: await runScan() }));

/**
 * DNS records, written for you.
 *
 * Under /system, so every write here is an owner's by the standing rule: the
 * token can rewrite where every domain points, which is the server's own key.
 */
systemRoutes.get('/dns', async (c) => {
  if (!hasDnsToken()) return c.json({ configured: false, zones: [] });
  try {
    return c.json({ configured: true, zones: await listZones() });
  } catch (err) {
    if (err instanceof DnsProviderError) {
      return c.json({ configured: true, zones: [], problem: err.message });
    }
    throw err;
  }
});

systemRoutes.put('/dns', async (c) => {
  const body = (await readBody(c)) as { token?: string | null };
  const value = body.token?.trim() || null;
  setDnsToken(value);
  if (!value) return c.json({ configured: false, zones: [] });
  // Proven now, not on first use: a bad paste should fail while the paster is
  // still looking at the box it went into.
  try {
    return c.json({ configured: true, zones: await listZones() });
  } catch (err) {
    setDnsToken(null);
    if (err instanceof DnsProviderError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

systemRoutes.post('/dns/write', async (c) => {
  const body = (await readBody(c)) as {
    hostname?: string;
    wildcard?: boolean;
  };
  const hostname = (body.hostname ?? '').trim().toLowerCase();
  if (!schemas.isHostname(hostname)) throw badRequest('Which domain?');
  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) {
    throw badRequest("Derailed doesn't know this server's address yet.");
  }
  try {
    const result = await writeRecordsFor(hostname, serverIp, {
      wildcard: body.wildcard === true,
    });
    // The record was just written where the check will look, so look now: the
    // domain card flips to "points here" while the person is still watching.
    const domain = findDomainByHostname(hostname);
    if (domain) await checkDomain(domain.id);
    return c.json(result);
  } catch (err) {
    if (err instanceof DnsProviderError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

/**
 * The server's door keys, and the toggle that matters.
 *
 * All of it under /system, so every write here is an owner's by the standing rule.
 * The fingerprint travels as a query value rather than a path segment because
 * OpenSSH fingerprints are base64 and base64 contains slashes.
 */
const presentKey = (key: { type: string; fingerprint: string; comment: string | null }) => ({
  type: key.type,
  fingerprint: key.fingerprint,
  comment: key.comment,
});

systemRoutes.get('/ssh', async (c) =>
  c.json({
    available: canManage(),
    keys: (await listKeys()).map(presentKey),
    passwordLogin: await passwordLoginState(),
  }),
);

systemRoutes.post('/ssh/keys', async (c) => {
  const body = (await readBody(c)) as { key?: string };
  if (!body.key?.trim()) throw badRequest('Paste a public key.');
  try {
    const key = await addKey(body.key);
    return c.json({ key: presentKey(key), keys: (await listKeys()).map(presentKey) }, 201);
  } catch (err) {
    if (err instanceof SshError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

systemRoutes.delete('/ssh/keys', async (c) => {
  const fingerprint = c.req.query('fingerprint');
  if (!fingerprint) throw badRequest('Which key?');
  try {
    await removeKey(fingerprint);
  } catch (err) {
    if (err instanceof SshError) throw badRequest(err.message, err.hint);
    throw err;
  }
  return c.json({ keys: (await listKeys()).map(presentKey) });
});

systemRoutes.put('/ssh/password-login', async (c) => {
  const body = (await readBody(c)) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') throw badRequest('On or off?');
  try {
    return c.json({ passwordLogin: await setPasswordLogin(body.enabled) });
  } catch (err) {
    if (err instanceof SshError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

/**
 * Puts right whatever the doctor offered to. Deliberately a fixed set of named
 * actions rather than anything the client can describe: this endpoint restarts the
 * proxy and deletes images, and "do what this string says" is not a shape that should
 * ever exist for either of those.
 */
systemRoutes.post('/doctor/fix/:action', async (c) => {
  const action = c.req.param('action');

  if (action === 'restart-proxy') {
    await ensureCaddyRunning();
    await syncRoutes();
    return c.json({ report: await runDoctor() });
  }
  if (action === 'reclaim-disk') {
    await freeUpSpace();
    return c.json({ report: await runDoctor() });
  }
  if (action === 'add-swap') {
    try {
      await addSwap((await swapState()).suggestedBytes);
    } catch (err) {
      if (err instanceof SwapError) throw badRequest(err.message, err.hint);
      throw err;
    }
    return c.json({ report: await runDoctor() });
  }

  throw badRequest('Derailed does not know how to fix that.');
});

systemRoutes.get('/disk', async (c) => c.json({ disk: await diskReport() }));

/**
 * What this machine is listening on, and what each one is for.
 *
 * A description rather than a firewall: Derailed does not enable ufw or write iptables
 * rules. A tool that manages a firewall on a remote server has one catastrophic
 * failure mode, which is locking the owner out of the machine it runs on, and the real
 * question people have is "what is this port and do I need it".
 */
systemRoutes.get('/ports', async (c) => c.json({ ports: await openPorts() }));

/**
 * Tidies up. Narrow on purpose: unused images, build scraps and stopped containers
 * Derailed made. Never volumes, never backups, never anything unlabelled.
 */
systemRoutes.post('/disk/reclaim', async (c) => c.json({ result: await freeUpSpace() }));

systemRoutes.get('/swap', async (c) => c.json({ swap: await swapState() }));

systemRoutes.post('/swap', async (c) => {
  const body = (await readBody(c)) as { bytes?: number };
  const state = await swapState();
  try {
    const made = await addSwap(body.bytes ?? state.suggestedBytes);
    return c.json({ swap: await swapState(), added: made.bytes });
  } catch (err) {
    if (err instanceof SwapError) throw badRequest(err.message, err.hint);
    throw err;
  }
});

/** Derailed itself, and whatever else someone put on this machine. */
/**
 * Everything every app is printing, in one place.
 *
 * "Something on this server is complaining and I do not know which" is a real question
 * and the only way to answer it before this was to open each app in turn. Each line
 * carries the app it came from, so the page can label them.
 */
systemRoutes.get('/logs', (c) => {
  const apps = listServices().filter((service) => service.kind === 'app');
  const lines = apps
    .flatMap((service) =>
      recentLogs(service.id).map((line) => ({
        ...line,
        serviceId: service.id,
        serviceName: service.name,
      })),
    )
    .sort((a, b) => a.ts - b.ts)
    .slice(-1000);

  return c.json({ lines });
});

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
  const body = (await readBody(c)) as { hostname?: string | null };
  const hostname = body.hostname?.trim().toLowerCase() || null;

  if (!hostname) {
    deleteSetting(SETTINGS.panelDomain);
    await syncRoutes();
    return c.json({ panelDomain: null });
  }

  if (!schemas.isHostname(hostname)) {
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

systemRoutes.get('/free-domain', async (c) => c.json({ freeDomain: await freeDomainState() }));

/**
 * Claims the free secured address.
 *
 * This is the one place a person can get a padlock without owning a domain. It works
 * because duckdns.org is on the public suffix list, so a name under it has a
 * certificate allowance of its own rather than sharing the one that every sslip.io
 * address in the world is already fighting over.
 */
systemRoutes.put('/free-domain', async (c) => {
  const body = (await readBody(c)) as {
    name?: string;
    token?: string;
    email?: string;
  };

  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) {
    throw badRequest(
      "Derailed doesn't know this server's public address yet.",
      'Set it in Settings first, then claim an address.',
    );
  }

  // Defaults to the account's own address, because it is already known and is where
  // an expiry warning should go anyway.
  const email = body.email?.trim() || c.get('user').email;

  /**
   * Progress goes out over the socket rather than down this response.
   *
   * The response cannot say anything until it is finished, and this is the one thing
   * in Derailed that routinely takes minutes: a tool to download, a DNS record to
   * propagate, and Let's Encrypt to answer. Three minutes of spinner is
   * indistinguishable from three minutes of hung, and people assume the second one.
   */
  const report = (progress: { step: FreeDomainStep; message: string; detail?: string }) => {
    publish(topics.system, { type: 'freedomain.progress', ...progress });
  };

  let state: Awaited<ReturnType<typeof freeDomainState>>;
  try {
    state = await claimFreeDomain({
      name: body.name ?? '',
      token: body.token ?? '',
      email,
      serverIp,
      onProgress: report,
    });
  } catch (err) {
    if (err instanceof FreeDomainError) throw badRequest(err.message, err.hint);
    throw err;
  }

  // The free address becomes where apps live, unless a domain of the person's own is
  // already doing that job. Theirs wins: they went to the trouble of pointing it here.
  if (!getSetting(SETTINGS.appBaseDomain) && state.hostname) {
    report({ step: 'addresses', message: 'Giving your apps their new addresses' });
    const added = await giveEveryAppAnAddress(state.hostname, serverIp);
    await syncRoutes();
    report({ step: 'done', message: 'Done' });
    return c.json({ freeDomain: state, added });
  }

  await syncRoutes();
  report({ step: 'done', message: 'Done' });
  return c.json({ freeDomain: state, added: 0 });
});

systemRoutes.delete('/free-domain', async (c) => {
  releaseFreeDomain();
  await syncRoutes();
  return c.json({ freeDomain: await freeDomainState() });
});

/**
 * Puts the addresses Derailed hands out on a domain of your own.
 *
 * The ready-made sslip.io addresses can never be secured: sslip.io is not on the
 * public suffix list, so Let's Encrypt counts every address in the world under it
 * against one allowance of fifty certificates a week. Point a wildcard at this server
 * instead and every app gets its own name with a real padlock.
 */
systemRoutes.put('/app-domain', async (c) => {
  const body = (await readBody(c)) as { domain?: string | null };
  const domain = body.domain?.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '') || null;

  if (!domain) {
    deleteSetting(SETTINGS.appBaseDomain);
    return c.json({ appDomain: null });
  }

  if (!schemas.isHostname(domain)) {
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
  /** Names that still have to be checked before they can be routed. */
  const toCheck: string[] = [];
  let added = 0;

  for (const service of listServices()) {
    if (service.kind !== 'app') continue;
    // Only apps that have been live at least once: an address for something that has
    // never started would just be a link to a 404.
    if (!listDomains(service.id).length) continue;

    const hostname = generatedHostname(service.slug, serverIp, domain);
    if (findDomainByHostname(hostname)) continue;
    added++;

    // A name under the free address needs no checking: the certificate covering it
    // already exists and DuckDNS already answers for it.
    if (isCoveredByFreeDomain(hostname)) {
      createDomain(service.id, hostname, 'generated', 'ok', 'active');
      continue;
    }
    toCheck.push(createDomain(service.id, hostname, 'generated', 'unchecked', 'pending').id);
  }

  // Check them now rather than waiting for the next sweep, so the padlock appears
  // while someone is still looking at the page they turned this on from.
  if (toCheck.length) {
    void (async () => {
      for (const id of toCheck) await checkDomain(id).catch(() => undefined);
      await syncRoutes().catch(() => undefined);
    })();
  }
  return added;
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
