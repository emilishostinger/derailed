import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FreeDomainStep } from '@derailed/shared';

/**
 * Claiming the free address, end to end, without DuckDNS or Let's Encrypt.
 *
 * The two things worth pinning are the two that cannot be seen from a unit test of
 * any single piece. The first is the order the stages happen in, because that order
 * is the whole of the progress display and a stage reported out of turn shows the
 * person a tick against something that has not happened. The second is the promise
 * in `claimFreeDomain`'s own doc comment: a failure half way through leaves the
 * server exactly as it was. That promise is the reason the writes are at the bottom
 * of the function, and nothing except a test stops somebody moving one up.
 *
 * The two outside services are replaced rather than reached. A test that needs a real
 * DuckDNS token is a test nobody runs.
 */

/** What the fake DuckDNS and lego do when called. Reset before each test. */
let pointFails: Error | null = null;
let certificateFails: Error | null = null;
let certificateLines: string[] = [];
const pointed: { name: string; token: string; ip: string }[] = [];

await mock.module('../src/proxy/duckdns.ts', () => ({
  normalizeName: (input: string) =>
    input
      .trim()
      .toLowerCase()
      .replace(/\.duckdns\.org$/, ''),
  isValidName: (name: string) => /^[a-z0-9-]{1,63}$/.test(name),
  hostnameFor: (name: string) => `${name}.duckdns.org`,
  pointAtServer: async (name: string, token: string, ip: string) => {
    if (pointFails) throw pointFails;
    pointed.push({ name, token, ip });
  },
  setChallengeRecord: async () => undefined,
  clearChallengeRecord: async () => undefined,
}));

await mock.module('../src/proxy/acme.ts', () => ({
  ensureCertificate: async (options: { onLine?: (line: string) => void }) => {
    for (const line of certificateLines) options.onLine?.(line);
    if (certificateFails) throw certificateFails;
    return true;
  },
  certificateExpiry: async () => Date.now() + 80 * 24 * 60 * 60 * 1000,
  needsRenewal: () => false,
}));

const { claimFreeDomain, freeDomainName, freeDomainState } = await import(
  '../src/proxy/freedomain.ts'
);
const { closeDb, initDb } = await import('../src/db/index.ts');
const { getSetting, SETTINGS } = await import('../src/db/repo/settings.ts');
const { loadSecretKey, resetSecretKeyCache } = await import('../src/util/crypto.ts');

const dir = mkdtempSync(join(tmpdir(), 'derailed-claim-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
  pointFails = null;
  certificateFails = null;
  certificateLines = [];
  pointed.length = 0;
});

afterEach(() => {
  closeDb();
});

/** Runs a claim and collects the stages it reported, in order, without repeats. */
async function claimReporting(overrides: Partial<Parameters<typeof claimFreeDomain>[0]> = {}) {
  const steps: FreeDomainStep[] = [];
  const details: string[] = [];

  await claimFreeDomain({
    name: 'my-server',
    token: 'a-token',
    email: 'me@example.com',
    serverIp: '203.0.113.7',
    onProgress: ({ step, detail }) => {
      if (steps[steps.length - 1] !== step) steps.push(step);
      if (detail) details.push(detail);
    },
    ...overrides,
  });

  return { steps, details };
}

describe('claiming a free address', () => {
  test('reports the stages in the order they happen', async () => {
    certificateLines = ['Downloading the certificate tool (lego 4.17.4)…'];
    const { steps } = await claimReporting();
    expect(steps).toEqual(['point', 'tool']);
  });

  test('moves on to the certificate stage when the tool says it has started', async () => {
    // The two stages share one callback, so which one a line belongs to is decided by
    // what the line says. This is the sentence that decides it.
    certificateLines = [
      'Downloading the certificate tool (lego 4.17.4)…',
      "Asking Let's Encrypt for a certificate covering my-server.duckdns.org…",
      '[INFO] acme: Obtaining bundled SAN certificate',
    ];
    const { steps } = await claimReporting();
    expect(steps).toEqual(['point', 'tool', 'certificate']);
  });

  test('never goes backwards once the certificate stage has started', async () => {
    // A stage reported out of turn puts a tick against something that has not
    // happened, which is worse than no progress at all.
    certificateLines = [
      "Asking Let's Encrypt for a certificate covering my-server.duckdns.org…",
      '[INFO] acme: use dns-01 solver',
      'Renewing the certificate…',
      '[INFO] acme: Validations succeeded',
    ];
    const { steps } = await claimReporting();
    expect(steps).toEqual(['point', 'tool', 'certificate']);
  });

  test('passes the tool output through as detail', async () => {
    certificateLines = ['[INFO] acme: use dns-01 solver', '[INFO] acme: Validations succeeded'];
    const { details } = await claimReporting();
    expect(details).toEqual(certificateLines);
  });

  test('points the name at the server before anything else', async () => {
    await claimReporting();
    expect(pointed).toEqual([{ name: 'my-server', token: 'a-token', ip: '203.0.113.7' }]);
  });

  test('remembers the name and the token once it has worked', async () => {
    const state = await claimFreeDomain({
      name: 'my-server',
      token: 'a-token',
      email: 'me@example.com',
      serverIp: '203.0.113.7',
    });

    expect(state.hostname).toBe('my-server.duckdns.org');
    expect(state.secured).toBe(true);
    expect(freeDomainName()).toBe('my-server');
    // Encrypted at rest, so the stored value is not the token itself.
    expect(getSetting(SETTINGS.freeDomainToken)).not.toBe('a-token');
    expect(getSetting(SETTINGS.freeDomainEmail)).toBe('me@example.com');
  });
});

/**
 * The promise in the function's own doc comment: nothing is remembered until it has
 * been shown to work, so a failure leaves the server exactly as it was. Somebody
 * whose token was wrong should not end up with a half-configured address that makes
 * every app resolve somewhere it should not.
 */
describe('when a claim fails part way', () => {
  test('a bad token leaves nothing behind', async () => {
    pointFails = new Error('DuckDNS said KO');

    await expect(
      claimFreeDomain({
        name: 'my-server',
        token: 'wrong',
        email: 'me@example.com',
        serverIp: '203.0.113.7',
      }),
    ).rejects.toThrow('DuckDNS said KO');

    expect(freeDomainName()).toBeNull();
    expect(getSetting(SETTINGS.freeDomainToken)).toBeNull();
    expect((await freeDomainState()).hostname).toBeNull();
  });

  test('a certificate that never arrives leaves nothing behind either', async () => {
    // The address is pointed at the server by this stage, which is harmless: it is a
    // DNS record on somebody else's service. What must not happen is Derailed
    // starting to hand out addresses under a name it has no certificate for.
    certificateFails = new Error('acme: error presenting token');

    await expect(
      claimFreeDomain({
        name: 'my-server',
        token: 'a-token',
        email: 'me@example.com',
        serverIp: '203.0.113.7',
      }),
    ).rejects.toThrow('acme: error presenting token');

    expect(pointed).toHaveLength(1);
    expect(freeDomainName()).toBeNull();
    expect(getSetting(SETTINGS.freeDomainEmail)).toBeNull();
  });

  test('refuses a name that is not one, without calling anything', async () => {
    for (const name of ['not a name', 'UPPER CASE!', '', 'has.dots']) {
      await expect(
        claimFreeDomain({
          name,
          token: 'a-token',
          email: 'me@example.com',
          serverIp: '203.0.113.7',
        }),
      ).rejects.toThrow(/isn't a DuckDNS name/);
    }
    expect(pointed).toHaveLength(0);
  });

  test('refuses an empty token, and says where to find it', async () => {
    await expect(
      claimFreeDomain({
        name: 'my-server',
        token: '   ',
        email: 'me@example.com',
        serverIp: '203.0.113.7',
      }),
    ).rejects.toThrow(/token is empty/);
    expect(pointed).toHaveLength(0);
  });
});
