import { Hono } from 'hono';
import { allDomains, findDomain } from '../../db/repo/domains.ts';
import { findService } from '../../db/repo/services.ts';
import {
  getBoolSetting,
  getSetting,
  SETTINGS,
  setBoolSetting,
  setSetting,
} from '../../db/repo/settings.ts';
import { checkNow, summaryFor } from '../../runtime/uptime.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

/** Behind the session, like everything else. The public half is mounted separately. */
export const uptimeRoutes = new Hono<AppEnv>();

uptimeRoutes.get('/', (c) =>
  c.json({
    sites: allDomains()
      .filter((domain) => domain.serviceId && !domain.redirectTo)
      .map((domain) => ({
        domain,
        service: domain.serviceId ? findService(domain.serviceId)?.name : null,
        uptime: summaryFor(domain.id),
      })),
    statusPage: {
      enabled: getBoolSetting(SETTINGS.statusPageEnabled),
      title: getSetting(SETTINGS.statusPageTitle) ?? 'Status',
    },
  }),
);

uptimeRoutes.post('/:id/check', async (c) => {
  const domain = findDomain(c.req.param('id'));
  if (!domain) throw notFound('That address');
  const result = await checkNow(domain.id);
  return c.json({ result, uptime: summaryFor(domain.id) });
});

uptimeRoutes.put('/status-page', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; title?: string };
  if (body.title !== undefined && body.title.length > 80) {
    throw badRequest('Keep the title under eighty characters.');
  }
  setBoolSetting(SETTINGS.statusPageEnabled, body.enabled === true);
  if (body.title !== undefined) setSetting(SETTINGS.statusPageTitle, body.title.trim() || 'Status');
  return c.json({
    enabled: getBoolSetting(SETTINGS.statusPageEnabled),
    title: getSetting(SETTINGS.statusPageTitle) ?? 'Status',
  });
});

/**
 * The public half.
 *
 * Deliberately outside the session check, and deliberately narrow: names, whether
 * they are up, and the ninety-day bar. No projects, no apps, no versions, no counts
 * of anything. A status page is something you send to a client or put in a README,
 * and it should give away nothing about the machine it runs on.
 *
 * Off until switched on, so a server that never asked for one never has one.
 */
export const publicStatusRoutes = new Hono();

export interface PublicStatus {
  title: string;
  at: number;
  allUp: boolean;
  sites: {
    name: string;
    /** Null when it has never been checked. */
    up: boolean | null;
    uptimePercent: number | null;
    /** `day` is the start of that day, in milliseconds. */
    days: { day: number; uptimePercent: number }[];
  }[];
}

/**
 * Everything the public is allowed to know, in one place.
 *
 * One function rather than two, because there are two ways to ask for this now and a
 * second copy of the filtering is a second place for something private to leak.
 */
export function publicStatus(): PublicStatus {
  const sites = allDomains()
    .filter((domain) => domain.serviceId && !domain.redirectTo && domain.kind === 'custom')
    .map((domain) => {
      const uptime = summaryFor(domain.id);
      return {
        name: domain.hostname,
        up: uptime.up,
        uptimePercent: uptime.uptimePercent,
        // Only the shape of each day, never a reason: a failure message can name an
        // upstream, a port or a container, and none of that is the public's business.
        days: uptime.days.map((day) => ({ day: day.day, uptimePercent: day.uptimePercent })),
      };
    });

  return {
    title: getSetting(SETTINGS.statusPageTitle) ?? 'Status',
    at: Date.now(),
    allUp: sites.every((site) => site.up !== false),
    sites,
  };
}

export function statusPageEnabled(): boolean {
  return getBoolSetting(SETTINGS.statusPageEnabled);
}

publicStatusRoutes.get('/status.json', (c) => {
  if (!statusPageEnabled()) return c.json({ error: 'Not found' }, 404);
  return c.json(publicStatus());
});
