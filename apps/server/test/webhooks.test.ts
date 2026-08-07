import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fire, sign } from '../src/alerts/webhooks.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import {
  createWebhook,
  findWebhook,
  listWebhooks,
  updateWebhook,
  webhookSecret,
} from '../src/db/repo/webhooks.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Telling something else what happened.
 *
 * The point of this over the webhook alert channel is that a program gets every
 * occurrence in a stable shape with a signature, rather than the deduplicated prose a
 * person reads in Discord. So the tests are about exactly that: what goes on the
 * wire, that it can be verified, and that a receiver being down cannot hurt the
 * thing that raised the event.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-webhooks-'));

/** A server that records what it was sent and answers however the test says. */
function receiver(options: { status?: number; delayMs?: number } = {}) {
  const received: { headers: Record<string, string>; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      received.push({
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });
      if (options.delayMs) await Bun.sleep(options.delayMs);
      return new Response('ok', { status: options.status ?? 200 });
    },
  });
  return { received, url: `http://127.0.0.1:${server.port}/hook`, stop: () => server.stop(true) };
}

/** Waits for the fire-and-forget delivery to land, or gives up. */
async function settled(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
}

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

describe('what goes on the wire', () => {
  test('a stable event name, the subject, and the fields under data', async () => {
    const target = receiver();
    createWebhook({ url: target.url });

    fire({
      event: 'deploy.failed',
      subject: 'svc_1',
      data: { title: 'Deploying Web failed', severity: 'warning' },
    });
    await settled(() => target.received.length > 0);

    const sent = JSON.parse(target.received[0]?.body ?? '{}');
    expect(sent.event).toBe('deploy.failed');
    expect(sent.subject).toBe('svc_1');
    expect(sent.data).toEqual({ title: 'Deploying Web failed', severity: 'warning' });
    expect(typeof sent.at).toBe('number');
    expect(typeof sent.delivery).toBe('string');

    expect(target.received[0]?.headers['x-derailed-event']).toBe('deploy.failed');
    expect(target.received[0]?.headers['x-derailed-delivery']).toBe(sent.delivery);
    target.stop();
  });

  test('a signature the receiver can check, over the exact bytes', async () => {
    // Over the body as sent, not over a re-serialisation of the parsed object: no two
    // languages agree on how to serialise JSON, and a receiver that has to match ours
    // byte for byte would fail for reasons nobody could debug.
    const target = receiver();
    createWebhook({ url: target.url, secret: 'a-shared-secret' });

    fire({ event: 'app.crashed', subject: 'svc_1', data: {} });
    await settled(() => target.received.length > 0);

    const { body, headers } = target.received[0] ?? { body: '', headers: {} };
    const expected = `sha256=${createHmac('sha256', 'a-shared-secret').update(body).digest('hex')}`;
    expect(headers['x-derailed-signature']).toBe(expected);
  });

  test('no signature header at all when no secret is set', async () => {
    // Rather than an empty or unsigned-but-present one, which a receiver checking
    // "is there a signature" would accept.
    const target = receiver();
    createWebhook({ url: target.url });

    fire({ event: 'app.crashed', subject: 'svc_1', data: {} });
    await settled(() => target.received.length > 0);
    expect(target.received[0]?.headers['x-derailed-signature']).toBeUndefined();
    target.stop();
  });

  test('sign is stable and depends on both the secret and the body', () => {
    expect(sign('s', 'body')).toBe(sign('s', 'body'));
    expect(sign('s', 'body')).not.toBe(sign('s2', 'body'));
    expect(sign('s', 'body')).not.toBe(sign('s', 'body2'));
    expect(sign('s', 'body')).toStartWith('sha256=');
  });
});

describe('who gets told', () => {
  test('only the webhooks that asked for this event', async () => {
    const wanted = receiver();
    const other = receiver();
    createWebhook({ url: wanted.url, events: ['deploy.failed'] });
    createWebhook({ url: other.url, events: ['backup.failed'] });

    fire({ event: 'deploy.failed', subject: 's', data: {} });
    await settled(() => wanted.received.length > 0);
    await Bun.sleep(150);

    expect(wanted.received).toHaveLength(1);
    expect(other.received).toHaveLength(0);
    wanted.stop();
    other.stop();
  });

  test('an empty event list means every event, which is the useful default', async () => {
    const target = receiver();
    createWebhook({ url: target.url });
    expect(listWebhooks()[0]?.events).toBeNull();

    fire({ event: 'job.failed', subject: 's', data: {} });
    await settled(() => target.received.length > 0);
    expect(target.received).toHaveLength(1);
    target.stop();
  });

  test('nothing at all when it is switched off', async () => {
    const target = receiver();
    const webhook = createWebhook({ url: target.url });
    updateWebhook(webhook.id, { enabled: false });

    fire({ event: 'deploy.failed', subject: 's', data: {} });
    await Bun.sleep(300);
    expect(target.received).toHaveLength(0);
    target.stop();
  });
});

describe('when the other end is unhappy', () => {
  test('a server error is tried again, and then recorded', async () => {
    const target = receiver({ status: 500 });
    const webhook = createWebhook({ url: target.url });

    fire({ event: 'deploy.failed', subject: 's', data: {} });
    await settled(() => (findWebhook(webhook.id)?.lastError ?? null) !== null, 6000);

    expect(target.received.length).toBe(2);
    expect(findWebhook(webhook.id)?.lastError).toContain('500');
    expect(findWebhook(webhook.id)?.lastStatus).toBeNull();
    target.stop();
  });

  test('a refusal is not tried again, because it is an answer', async () => {
    // A 4xx is the receiver saying no. Sending it twice produces two rejections.
    const target = receiver({ status: 403 });
    const webhook = createWebhook({ url: target.url });

    fire({ event: 'deploy.failed', subject: 's', data: {} });
    await settled(() => (findWebhook(webhook.id)?.lastError ?? null) !== null, 6000);

    expect(target.received).toHaveLength(1);
    expect(findWebhook(webhook.id)?.lastError).toContain('403');
    target.stop();
  });

  test('a success is recorded, so the screen can say it works', async () => {
    const target = receiver();
    const webhook = createWebhook({ url: target.url });

    fire({ event: 'deploy.succeeded', subject: 's', data: {} });
    await settled(() => (findWebhook(webhook.id)?.lastStatus ?? null) !== null);

    expect(findWebhook(webhook.id)?.lastStatus).toBe(200);
    expect(findWebhook(webhook.id)?.lastError).toBeNull();
    target.stop();
  });

  test('an address nobody is listening on cannot throw at the caller', async () => {
    // `fire` is called from the middle of a deploy. A webhook pointing at a machine
    // that has been switched off must not slow it down, and must certainly not fail
    // it. This test passes by not exploding.
    createWebhook({ url: 'http://127.0.0.1:1/nothing-here' });
    expect(() => fire({ event: 'deploy.failed', subject: 's', data: {} })).not.toThrow();
    await Bun.sleep(1500);
  });
});

describe('the secret itself', () => {
  test('is encrypted at rest and never on the object the API returns', () => {
    const webhook = createWebhook({ url: 'https://example.com/hook', secret: 'a-shared-secret' });

    expect(JSON.stringify(webhook)).not.toContain('a-shared-secret');
    expect(webhook.hasSecret).toBe(true);
    // Readable by the one thing that needs it, which is the signing.
    expect(webhookSecret(webhook.id)).toBe('a-shared-secret');
  });

  test('is absent rather than empty when none was given', () => {
    const webhook = createWebhook({ url: 'https://example.com/hook', secret: '   ' });
    expect(webhook.hasSecret).toBe(false);
    expect(webhookSecret(webhook.id)).toBeNull();
  });
});
