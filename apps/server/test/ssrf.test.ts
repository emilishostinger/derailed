/**
 * The panel fetching an address somebody else chose.
 *
 * `POST /projects/:id/templates` takes a `url` and fetches it, server-side, from
 * inside whatever network the server sits in. That is the whole shape of server-side
 * request forgery, and the only guard was a check that the scheme was https.
 *
 * It did not hold. `redirect: 'follow'` meant the check applied to the address that
 * was typed and to nothing after it, so an ordinary https link answering
 * `302 Location: http://169.254.169.254/` reached the metadata service over plain
 * http. Driving a real server proved it: a plain-HTTP listener on loopback recorded
 * the request. Whether a port answered was distinguishable too, from the different
 * message, which made the endpoint a port scanner for the private network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fetchTemplate, TemplateError } from '../src/catalog/templates.ts';
import {
  BlockedAddressError,
  fetchPublic,
  isBlockedFetchAddress,
  resolvesToBlockedAddress,
} from '../src/util/net.ts';

describe('addresses the server will not fetch', () => {
  test('anything on this machine or this network', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      // The cloud metadata service, which is the reason anybody writes one of these.
      '169.254.169.254',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
      // Carrier-grade NAT, benchmarking, protocol assignments, multicast, broadcast.
      '100.64.0.1',
      '198.18.0.1',
      '192.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
      'ff02::1',
    ]) {
      expect(isBlockedFetchAddress(address)).toBe(true);
    }
  });

  test('but the public internet is still reachable', () => {
    for (const address of [
      '203.0.113.7',
      '8.8.8.8',
      '1.1.1.1',
      '99.99.99.99',
      '100.63.255.255',
      '100.128.0.1',
      '198.20.0.1',
      '2606:4700::1111',
    ]) {
      expect(isBlockedFetchAddress(address)).toBe(false);
    }
  });

  test('a name is resolved rather than pattern-matched', async () => {
    // `internal.example.com` is an ordinary-looking name that answers 10.0.0.5.
    // Reading the text of a URL would wave it straight through.
    expect(await resolvesToBlockedAddress('localhost')).toBe(true);
    expect(await resolvesToBlockedAddress('127.0.0.1')).toBe(true);
    expect(await resolvesToBlockedAddress('[::1]')).toBe(true);
  });

  test('a name that does not resolve is refused rather than attempted', async () => {
    expect(await resolvesToBlockedAddress('this-name-does-not-exist.invalid')).toBe(true);
  });
});

describe('fetchPublic', () => {
  test('does not even open the connection to a local service', async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        hits++;
        return new Response('should never be reached');
      },
    });

    try {
      await expect(fetchPublic(`http://127.0.0.1:${server.port}/`)).rejects.toThrow(
        BlockedAddressError,
      );
      // The point is not the error, it is that nothing was sent.
      expect(hits).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test('refuses a scheme it was not given', async () => {
    await expect(fetchPublic('http://example.com/', {}, { protocols: ['https:'] })).rejects.toThrow(
      BlockedAddressError,
    );
    await expect(fetchPublic('file:///etc/passwd')).rejects.toThrow(BlockedAddressError);
    await expect(fetchPublic('gopher://example.com/')).rejects.toThrow(BlockedAddressError);
  });
});

/**
 * The redirect chain, with `fetch` itself stood in for.
 *
 * The hops are what actually broke, and reproducing them for real needs a public
 * address that redirects where we say. Replacing `fetch` keeps the test honest about
 * the part that matters: which URLs `fetchPublic` is willing to ask for.
 *
 * The permitted hop is written as a literal address from TEST-NET-3, the block reserved
 * for documentation, rather than a name. A name would mean a real DNS lookup, and a
 * lookup that is slow or unanswered makes the address look blocked, which is this test
 * passing and failing depending on the network.
 */
describe('following a redirect', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  function stub(map: Record<string, Response>): string[] {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const response = map[url];
      if (!response) throw new Error(`unexpected fetch: ${url}`);
      return response;
    }) as unknown as typeof fetch;
    return asked;
  }

  test('stops at a hop that points back at this machine', async () => {
    const asked = stub({
      'https://203.0.113.10/t.json': new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1:9443/admin' },
      }),
    });

    await expect(fetchPublic('https://203.0.113.10/t.json')).rejects.toThrow(BlockedAddressError);
    // The first hop was asked for, the second never was.
    expect(asked).toEqual(['https://203.0.113.10/t.json']);
  });

  test('will not be walked down from https to plain http', async () => {
    const asked = stub({
      'https://203.0.113.10/t.json': new Response(null, {
        status: 302,
        headers: { location: 'http://203.0.113.10/t.json' },
      }),
    });

    await expect(
      fetchPublic('https://203.0.113.10/t.json', {}, { protocols: ['https:'] }),
    ).rejects.toThrow(BlockedAddressError);
    expect(asked).toEqual(['https://203.0.113.10/t.json']);
  });

  test('gives up rather than going round for ever', async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://203.0.113.10/loop' },
      })) as unknown as typeof fetch;

    await expect(fetchPublic('https://203.0.113.10/loop')).rejects.toThrow(/too many times/);
  });
});

describe('a template fetched from a link', () => {
  test('cannot be used to reach the metadata service', async () => {
    await expect(fetchTemplate('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      TemplateError,
    );
  });

  test('cannot be pointed at the machine it is running on', async () => {
    for (const url of [
      'https://127.0.0.1/template.json',
      'https://localhost/template.json',
      'https://10.0.0.5/template.json',
      'https://[::1]/template.json',
    ]) {
      const error = await fetchTemplate(url).catch((err) => err);
      expect(error).toBeInstanceOf(TemplateError);
      expect(String(error.message)).toMatch(/private network|not fetched|machine/i);
    }
  });

  test('is still refused over plain http', async () => {
    const error = await fetchTemplate('http://example.com/template.json').catch((err) => err);
    expect(error).toBeInstanceOf(TemplateError);
    expect(String(error.message)).toMatch(/https/i);
  });

  test('and something that is not an address at all is said plainly', async () => {
    await expect(fetchTemplate('not a url')).rejects.toThrow(TemplateError);
  });
});
