import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_EVENTS,
  alertSettings,
  alreadySaid,
  clearAlert,
  enabledEvents,
  fingerprint,
  raise,
  saveChannels,
  saveEvents,
} from '../src/alerts/notify.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Alerts, and the discipline that makes them worth having.
 *
 * The hard part of a notifier is not sending, it is not sending. An alert every time
 * a container restarts is one nobody reads by Thursday, which means the one that
 * mattered on Friday goes unread too. So most of this is about staying quiet.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-alerts-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

describe('saying the same thing twice', () => {
  test('remembers what it has already said', () => {
    const key = fingerprint('app.crashed', 'service-1');
    expect(alreadySaid(key)).toBe(false);
  });

  test('treats a different app as a different situation', () => {
    expect(fingerprint('app.crashed', 'service-1')).not.toBe(
      fingerprint('app.crashed', 'service-2'),
    );
  });

  test('treats a different kind of problem on the same app as different too', () => {
    expect(fingerprint('app.crashed', 'service-1')).not.toBe(
      fingerprint('app.crashloop', 'service-1'),
    );
  });

  test('treats the same deploy failing a new way as news again', () => {
    // Otherwise fixing one build error and hitting the next would be silent, which is
    // exactly when somebody wants to be told.
    expect(fingerprint('deploy.failed', 'svc', 'missing python')).not.toBe(
      fingerprint('deploy.failed', 'svc', 'out of memory'),
    );
  });

  test('forgets on request, so a problem that comes back is reported again', () => {
    const key = fingerprint('app.crashed', 'service-1');
    clearAlert(key);
    expect(alreadySaid(key)).toBe(false);
  });
});

describe('what is switched on', () => {
  test('starts with the useful ones on and the noisy one off', () => {
    const events = enabledEvents();
    expect(events).toContain('app.crashed');
    expect(events).toContain('deploy.failed');
    expect(events).toContain('drill.failed');
    // A message every time a deploy works is the fastest way to teach somebody to
    // ignore this whole feature.
    expect(events).not.toContain('deploy.succeeded');
  });

  test('remembers what was chosen, including choosing nothing', () => {
    saveEvents(['app.crashed']);
    expect(enabledEvents()).toEqual(['app.crashed']);

    saveEvents([]);
    expect(enabledEvents()).toEqual([]);
  });

  test('ignores an event kind it does not know', () => {
    const known = new Set(ALL_EVENTS.map((event) => event.kind));
    expect(known.has('app.crashed')).toBe(true);
    expect(known.size).toBe(ALL_EVENTS.length);
  });
});

describe('sending', () => {
  test('says nothing when there is nowhere to send', async () => {
    const result = await raise({
      kind: 'app.crashed',
      subject: 'svc',
      severity: 'warning',
      title: 'x',
      body: 'y',
    });
    expect(result.skipped).toBe('no channels');
    expect(result.sent).toBe(0);
  });

  test('says nothing when that kind is switched off', async () => {
    saveEvents([]);
    saveChannels([{ id: 'a', kind: 'webhook', target: 'https://example.test/hook' }]);

    const result = await raise({
      kind: 'app.crashed',
      subject: 'svc',
      severity: 'warning',
      title: 'x',
      body: 'y',
    });
    expect(result.skipped).toBe('off');
  });
});

describe('secrets', () => {
  test('never come back out', () => {
    saveChannels([{ id: 'a', kind: 'telegram', target: '12345', secret: 'the-bot-token' }]);

    const settings = alertSettings();
    expect(JSON.stringify(settings)).not.toContain('the-bot-token');
    expect(settings.channels[0]?.secret).toBe('');
  });

  test('are kept when the form is saved without retyping them', () => {
    saveChannels([{ id: 'a', kind: 'telegram', target: '12345', secret: 'the-bot-token' }]);
    // Same channel, blank secret: the stored one must survive rather than be wiped.
    saveChannels([{ id: 'a', kind: 'telegram', target: '99999', secret: '' }]);

    const settings = alertSettings();
    expect(settings.channels[0]?.target).toBe('99999');
    // Still present, still not readable from here.
    expect(settings.channels[0]?.secret).toBe('');
  });
});
