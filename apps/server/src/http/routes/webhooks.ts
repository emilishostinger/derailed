import type { AlertEventKind } from '@derailed/shared';
import { Hono } from 'hono';
import { ALL_EVENTS } from '../../alerts/notify.ts';
import { fire } from '../../alerts/webhooks.ts';
import {
  createWebhook,
  deleteWebhook,
  findWebhook,
  listWebhooks,
  updateWebhook,
} from '../../db/repo/webhooks.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound, readBody } from '../errors.ts';

/**
 * Places to tell when something happens.
 *
 * Owner-only, like everything else that is about the machine rather than an app: a
 * webhook is somewhere Derailed talks to on its own, and the list of those is the
 * sort of thing that should not quietly grow.
 */
export const webhookRoutes = new Hono<AppEnv>();

const KNOWN = new Set(ALL_EVENTS.map((event) => event.kind));

function parseEvents(input: unknown): AlertEventKind[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const events = input.filter((entry): entry is AlertEventKind =>
    KNOWN.has(entry as AlertEventKind),
  );
  if (events.length !== input.length) {
    throw badRequest(
      'That list contains something Derailed never sends.',
      `The events are: ${[...KNOWN].join(', ')}.`,
    );
  }
  return events;
}

webhookRoutes.get('/', (c) => c.json({ webhooks: listWebhooks(), kinds: ALL_EVENTS }));

webhookRoutes.post('/', async (c) => {
  const body = (await readBody(c)) as {
    url?: string;
    secret?: string;
    events?: unknown;
  };

  const target = body.url?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw badRequest(`"${target}" is not a web address.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest('A webhook has to be an http or https address.');
  }

  const webhook = createWebhook({
    url: target,
    secret: body.secret ?? null,
    events: parseEvents(body.events),
  });
  return c.json({ webhook }, 201);
});

webhookRoutes.patch('/:id', async (c) => {
  const webhook = findWebhook(c.req.param('id'));
  if (!webhook) throw notFound('That webhook');

  const body = (await readBody(c)) as { enabled?: boolean; events?: unknown };
  return c.json({
    webhook: updateWebhook(webhook.id, {
      enabled: body.enabled,
      events: body.events === undefined ? undefined : parseEvents(body.events),
    }),
  });
});

webhookRoutes.delete('/:id', (c) => {
  const webhook = findWebhook(c.req.param('id'));
  if (!webhook) throw notFound('That webhook');
  deleteWebhook(webhook.id);
  return c.json({ ok: true });
});

/**
 * Sends one, now, so the other end can be checked before it matters.
 *
 * Fires through the ordinary path rather than a special one, so what arrives is
 * exactly the shape a real event arrives in, signature included. A test that takes a
 * different route is a test of the test.
 */
webhookRoutes.post('/:id/test', (c) => {
  const webhook = findWebhook(c.req.param('id'));
  if (!webhook) throw notFound('That webhook');
  if (!webhook.enabled) throw badRequest('That webhook is switched off.');

  fire({
    event: 'deploy.succeeded',
    subject: 'test',
    data: {
      title: 'A test from Derailed',
      body: 'If you are reading this, the address and the signature both work.',
      action: null,
      severity: 'info',
      url: null,
      test: true,
    },
  });
  return c.json({ sent: true, note: 'Check the other end, then look at the status here.' });
});
