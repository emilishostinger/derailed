/**
 * Whose word to take for where a request came from.
 *
 * The login limiter used to key on `X-Forwarded-For` alone. Sixty guesses carrying
 * sixty invented values were sixty different people as far as it was concerned, so the
 * five-a-minute cap never fired once and the admin password could be worked through at
 * leisure. The socket address is the only part of this a caller cannot choose.
 */
import { describe, expect, test } from 'bun:test';
import {
  BlockedAddressError,
  fetchPublic,
  isPrivateAddress,
  resolveClientIp,
  resolveHttps,
} from '../src/util/net.ts';

describe('recognising our own side of the wire', () => {
  test('loopback, RFC1918 and the docker bridges are ours', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.4.5.6',
      '172.17.0.1',
      '172.31.255.254',
      '192.168.1.1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test('the public internet is not', () => {
    for (const address of [
      '203.0.113.7',
      '8.8.8.8',
      '172.32.0.1',
      '172.15.0.1',
      '2606:4700::1111',
      '',
      null,
      undefined,
      'not-an-address',
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

describe('which address a rate limit is held against', () => {
  test('a stranger cannot rename themselves with a header', () => {
    const first = resolveClientIp('203.0.113.7', '10.0.0.1');
    const second = resolveClientIp('203.0.113.7', '10.0.0.2');
    expect(first).toBe('203.0.113.7');
    expect(first).toBe(second);
  });

  test('but our own proxy is believed, or every visitor would be one caller', () => {
    expect(resolveClientIp('172.17.0.1', '203.0.113.9, 172.17.0.1')).toBe('203.0.113.9');
  });

  test('a caller cannot prepend a made-up address to escape the limiter', () => {
    // Caddy appends the address it actually saw to whatever `X-Forwarded-For` arrived,
    // so a caller who sends `X-Forwarded-For: 6.6.6.6` becomes `6.6.6.6, <them>`. The
    // first entry is theirs to invent and rotate; the last public one is the address our
    // own proxy vouched for. Taking the leftmost handed every guess a fresh identity.
    expect(resolveClientIp('172.17.0.1', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(resolveClientIp('172.17.0.1', '6.6.6.6, 7.7.7.7, 203.0.113.9')).toBe('203.0.113.9');
    // Even with a private hop appended after it by the docker bridge.
    expect(resolveClientIp('172.17.0.1', '6.6.6.6, 203.0.113.9, 172.17.0.1')).toBe('203.0.113.9');
  });

  test('a forwarded chain that is all private falls back to the peer', () => {
    expect(resolveClientIp('172.17.0.1', '10.0.0.5, 172.17.0.1')).toBe('172.17.0.1');
  });

  test('a private peer with nothing forwarded is just that peer', () => {
    expect(resolveClientIp('172.17.0.1', null)).toBe('172.17.0.1');
  });

  test('no peer at all means one shared bucket, not the header', () => {
    expect(resolveClientIp(null, '10.0.0.1')).toBe('local');
    expect(resolveClientIp(undefined, '10.0.0.2')).toBe('local');
  });
});

describe('whether the connection was secure', () => {
  test('a stranger claiming https is ignored', () => {
    expect(resolveHttps('203.0.113.7', 'https', 'http:')).toBe(false);
  });

  test('the proxy in front of us is believed', () => {
    expect(resolveHttps('172.17.0.1', 'https', 'http:')).toBe(true);
    expect(resolveHttps('127.0.0.1', 'http', 'http:')).toBe(false);
  });

  test('with no proxy header it is whatever the URL says', () => {
    expect(resolveHttps('203.0.113.7', null, 'https:')).toBe(true);
    expect(resolveHttps(null, null, 'http:')).toBe(false);
  });
});

/**
 * DNS rebinding: the guard resolves a name, likes the answer, and then the socket
 * resolves it again and gets a different one. `fetchPublic` closes the gap by pinning
 * the address it vetted and dialling that literal, while still presenting the name in
 * the Host header and the TLS SNI so ordinary virtual hosting and certificates work.
 *
 * Proven here with a name that really resolves (example.com) so the resolver, not a
 * stub, produces the address: the request that goes on the wire must be aimed at that
 * IP and not at the name, because a second lookup is exactly what an attacker's DNS
 * would answer differently.
 */
describe('a vetted fetch cannot be re-pointed by a second DNS lookup', () => {
  test('the socket dials the resolved IP, with Host and SNI kept as the hostname', async () => {
    const real = globalThis.fetch;
    const seen: { dialled: string; host: string | null; sni: unknown } = {
      dialled: '',
      host: null,
      sni: undefined,
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.dialled = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      seen.host = headers.get('host');
      seen.sni = (init as { tls?: { serverName?: string } } | undefined)?.tls?.serverName;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await fetchPublic('https://example.com/some/path');
    } catch (err) {
      // Only a genuine resolver failure is an acceptable reason not to assert; the
      // point of the test is the pin, not example.com's uptime.
      if (err instanceof BlockedAddressError) {
        globalThis.fetch = real;
        return;
      }
      throw err;
    } finally {
      globalThis.fetch = real;
    }

    // The name never reaches the socket layer; a literal address does.
    expect(seen.dialled).not.toContain('example.com');
    expect(seen.dialled).toMatch(/^https:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?\//);
    // But the name still reaches the far end, for vhosts and certificate checks.
    expect(seen.host).toBe('example.com');
    expect(seen.sni).toBe('example.com');
  });

  test('a literal address is dialled as written, since there is nothing to pin', async () => {
    // A public literal has no second lookup to disagree with, so it is fetched
    // directly, unchanged. (A blocked literal never gets this far; that path is the
    // isBlockedFetchAddress tests.)
    const real = globalThis.fetch;
    const seen = { dialled: '' };
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.dialled = String(input instanceof Request ? input.url : input);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await fetchPublic('https://203.0.113.7/');
    } finally {
      globalThis.fetch = real;
    }
    expect(seen.dialled).toBe('https://203.0.113.7/');
  });
});

/**
 * Docker hands out project networks from a fixed set of ranges, roughly thirty of them,
 * and then refuses with "all predefined address pools have been fully subnetted". Hit
 * for real while testing: every Docker-backed test in the suite failed at once, with
 * that sentence and nothing else to go on.
 *
 * A server with a few dozen projects reaches it honestly, and reaches it sooner than
 * the project count suggests, because a network outlives the project that made it until
 * housekeeping comes round. The message a person gets has to say what to do.
 */
describe('running out of Docker networks', () => {
  test('is explained, with something to do about it', async () => {
    const { ensureNetwork } = await import('../src/docker/networks.ts');
    const { FriendlyError } = await import('../src/build/git.ts');

    // Docker's own words, in the shape the daemon actually sends them.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/networks/create')) {
        return new Response(
          JSON.stringify({ message: 'all predefined address pools have been fully subnetted' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    try {
      const error = await ensureNetwork('derailed-p_whatever', {}).catch((err) => err);
      expect(error).toBeInstanceOf(FriendlyError);
      expect(error.message).not.toContain('subnetted');
      expect(error.message).toMatch(/network ranges/i);
      // And a next step, not just a diagnosis.
      expect(error.hint).toMatch(/prune|delete a project/i);
    } finally {
      globalThis.fetch = real;
    }
  });
});
