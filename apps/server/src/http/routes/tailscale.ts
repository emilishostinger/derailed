import { Hono } from 'hono';
import { allDomains, createDomain, deleteDomain } from '../../db/repo/domains.ts';
import { findService } from '../../db/repo/services.ts';
import { caddyHttpPort } from '../../proxy/caddy.ts';
import { syncRoutes } from '../../proxy/sync.ts';
import {
  installTailscale,
  isTailnetHostname,
  setFunnel,
  tailscaleState,
  tailscaleUp,
} from '../../system/tailscale.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

/**
 * The cupboard computer's screen. Mounted under /system, so every write here is
 * an owner's, which joining networks and opening doors to the internet should be.
 */
export const tailscaleRoutes = new Hono<AppEnv>();

/** Which app, if any, is shared to the internet through the funnel. */
function funnelDomain() {
  return allDomains().find((domain) => isTailnetHostname(domain.hostname)) ?? null;
}

tailscaleRoutes.get('/', async (c) => {
  const state = await tailscaleState();
  const shared = funnelDomain();
  return c.json({
    ...state,
    funnelServiceId: shared?.serviceId ?? null,
  });
});

/** Brings Tailscale onto the box, the same way install.sh brings Docker. */
tailscaleRoutes.post('/install', async (c) => {
  const result = await installTailscale();
  if (!result.ok) throw badRequest(result.message);
  return c.json(result);
});

/** Joins the tailnet: with an auth key silently, without one via a sign-in link. */
tailscaleRoutes.post('/connect', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { authKey?: string };
  const result = await tailscaleUp(body.authKey?.trim() || undefined);
  if (!result.ok && !result.loginUrl) {
    throw badRequest(result.message ?? 'Tailscale could not connect.');
  }
  return c.json(result);
});

/**
 * Shares one app with the whole internet through Funnel, or stops.
 *
 * The mechanics are one domain row (the box's ts.net name, pointed at the app)
 * plus the funnel itself, which terminates TLS with a real certificate and hands
 * the traffic to the proxy. Nothing about the app changes; it gains an address.
 */
tailscaleRoutes.put('/funnel', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { serviceId?: string | null };
  const state = await tailscaleState();
  if (!state.connected || !state.dnsName) {
    throw badRequest('Connect this server to your tailnet first.');
  }

  const existing = funnelDomain();

  if (!body.serviceId) {
    if (existing) deleteDomain(existing.id);
    const off = await setFunnel(false, caddyHttpPort());
    if (!off.ok) throw badRequest(off.message ?? 'Tailscale refused.');
    await syncRoutes();
    return c.json({ funnelServiceId: null });
  }

  const service = findService(body.serviceId);
  if (service?.kind !== 'app') throw notFound('That app');

  if (existing) deleteDomain(existing.id);
  // dns 'ok' because there is no public record to wait for, and TLS 'disabled'
  // because tailscaled holds the certificate, not Caddy.
  createDomain(service.id, state.dnsName, 'custom', 'ok', 'disabled');
  const on = await setFunnel(true, caddyHttpPort());
  if (!on.ok) {
    throw badRequest(
      on.message ?? 'Tailscale refused to open the funnel.',
      'Funnel needs to be allowed for your tailnet: one approval in the Tailscale admin console.',
    );
  }
  await syncRoutes();
  return c.json({ funnelServiceId: service.id, hostname: state.dnsName });
});
