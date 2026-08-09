/**
 * DNS rebinding, driven with a resolver we control.
 *
 * `net.test.ts` proves the pin against a name that really resolves; this proves the
 * attack cannot get through, by making the resolver lie the way an attacker's would.
 * The defence is that `fetchPublic` resolves a name exactly once, vets that answer, and
 * then dials that literal address, so a second lookup, which is where a rebinding
 * attacker swaps a public answer for a private one, never happens for the connection.
 *
 * The resolver is mocked so a test can hand back a public address the first time and a
 * private one after, count how often it was asked, and check which address actually
 * went on the wire.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { lookup as realLookup } from 'node:dns/promises';

// A controllable stand-in for the OS resolver. It behaves exactly like the real one
// unless a test arms it, so that after this file's tests run in a shared process the
// resolver is not left lying to everyone else. When armed, `answers` is what the next
// lookup returns and `calls` counts how often it was asked, which is how the second
// lookup an attacker relies on is shown never to happen.
let armed = false;
let answers: { address: string; family: number }[] = [];
let calls = 0;
mock.module('node:dns/promises', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: the real lookup's overloads are wide.
  lookup: async (host: string, opts?: unknown): Promise<any> => {
    if (!armed) return realLookup(host, opts as never);
    calls += 1;
    return answers;
  },
}));

const { fetchPublic, BlockedAddressError } = await import('../src/util/net.ts');

let seen: { dialled: string; host: string | null; sni: unknown; redirect: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  armed = true;
  calls = 0;
  seen = { dialled: '', host: null, sni: undefined, redirect: undefined };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.dialled = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    seen.host = headers.get('host');
    seen.sni = (init as { tls?: { serverName?: string } } | undefined)?.tls?.serverName;
    seen.redirect = init?.redirect;
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  armed = false;
  globalThis.fetch = realFetch;
});

describe('the resolved address is pinned, so a rebind cannot re-point the connection', () => {
  test('a public name is dialled at the address it resolved to, once', async () => {
    answers = [{ address: '203.0.113.7', family: 4 }];
    await fetchPublic('https://rebind.example/path');
    // The socket dials the vetted IP, not the name.
    expect(seen.dialled).toBe('https://203.0.113.7/path');
    // The name is still presented to the far end for vhosts and certificates.
    expect(seen.host).toBe('rebind.example');
    expect(seen.sni).toBe('rebind.example');
    // Redirects are followed by hand, per hop, so the scheme/address checks are not
    // skipped by fetch's own follower.
    expect(seen.redirect).toBe('manual');
    // Resolved exactly once: there is no second lookup for an attacker to answer.
    expect(calls).toBe(1);
  });

  test('an IPv6 answer is dialled bracketed, with the name still in Host and SNI', async () => {
    answers = [{ address: '2606:4700:4700::1111', family: 6 }];
    await fetchPublic('https://v6.example/');
    expect(seen.dialled).toBe('https://[2606:4700:4700::1111]/');
    expect(seen.host).toBe('v6.example');
    expect(seen.sni).toBe('v6.example');
  });

  test('a name that resolves to a private address is refused, and never dialled', async () => {
    // The rebind payload: the name answers a private, internal address.
    answers = [{ address: '10.0.0.5', family: 4 }];
    const err = await fetchPublic('https://internal.example/').catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    // Nothing went on the wire.
    expect(seen.dialled).toBe('');
  });

  test('a name that answers one public and one private address is refused (the oldest trick)', async () => {
    answers = [
      { address: '203.0.113.9', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    const err = await fetchPublic('https://mixed.example/').catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(seen.dialled).toBe('');
  });

  test('a name that will not resolve is refused, not fetched', async () => {
    answers = [];
    const err = await fetchPublic('https://nxdomain.example/').catch((e) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(seen.dialled).toBe('');
  });
});
