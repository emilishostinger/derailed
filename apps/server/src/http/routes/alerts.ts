import type { AlertChannel, AlertEventKind } from '@derailed/shared';
import { Hono } from 'hono';
import {
  ALL_EVENTS,
  alertSettings,
  raise,
  saveChannels,
  saveEvents,
  testChannel,
} from '../../alerts/notify.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const alertRoutes = new Hono<AppEnv>();

alertRoutes.get('/', (c) => c.json({ settings: alertSettings(), kinds: ALL_EVENTS }));

alertRoutes.put('/channels', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { channels?: AlertChannel[] };
  if (!Array.isArray(body.channels)) throw badRequest('Send a list of channels.');

  for (const channel of body.channels) {
    if (!channel.id || !channel.kind) throw badRequest('Every channel needs an id and a kind.');
    if (!channel.target?.trim()) throw badRequest('Every channel needs somewhere to send to.');
    // Everything but Telegram (a chat id) is a URL we will POST to, and a typo here is
    // otherwise only discovered at the moment an alert matters.
    if (channel.kind !== 'telegram') {
      try {
        const url = new URL(channel.target);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      } catch {
        throw badRequest(`"${channel.target}" is not a web address.`);
      }
    }
  }

  return c.json({ settings: saveChannels(body.channels) });
});

alertRoutes.put('/events', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { events?: AlertEventKind[] };
  if (!Array.isArray(body.events)) throw badRequest('Send a list of events.');

  const known = new Set(ALL_EVENTS.map((event) => event.kind));
  const events = body.events.filter((event) => known.has(event));
  return c.json({ settings: saveEvents(events) });
});

/** Sends one test alert, ignoring every rule about not repeating itself. */
alertRoutes.post('/channels/:id/test', async (c) => {
  try {
    await testChannel(c.req.param('id'));
  } catch (err) {
    throw badRequest('That did not get through.', err instanceof Error ? err.message : undefined);
  }
  return c.json({ ok: true });
});

/** Fires a real alert of every kind at once, for anyone checking the wiring. */
alertRoutes.post('/test', async (c) => {
  const result = await raise({
    kind: 'app.crashed',
    subject: 'test',
    force: true,
    severity: 'info',
    title: 'Derailed is set up correctly',
    body: 'This is a test alert. If you are reading it, this server can reach you.',
  });
  if (result.skipped === 'no channels') throw notFound('Anywhere to send to');
  return c.json({ result });
});
