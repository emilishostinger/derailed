/**
 * Whose word to take for where a request came from.
 *
 * The login limiter used to key on `X-Forwarded-For` alone. Sixty guesses carrying
 * sixty invented values were sixty different people as far as it was concerned, so the
 * five-a-minute cap never fired once and the admin password could be worked through at
 * leisure. The socket address is the only part of this a caller cannot choose.
 */
import { describe, expect, test } from 'bun:test';
import { isPrivateAddress, resolveClientIp, resolveHttps } from '../src/util/net.ts';

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
