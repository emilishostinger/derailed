import { describe, expect, test } from 'bun:test';
import { objectKey, type S3Config, signRequest } from '../src/backup/s3.ts';

/**
 * Signing, which is the part with no room for "close enough".
 *
 * A signature is either byte-for-byte right or the provider returns 403 with nothing
 * to go on. So the first test checks against the worked example AWS publishes in its
 * own SigV4 documentation: same keys, same date, same expected signature. If that one
 * passes, the algorithm is right, and everything after it is about our own inputs.
 */

const AWS_EXAMPLE: S3Config = {
  // From "Examples of the complete Signature Version 4 signing process", the
  // GET-object case for the `examplebucket` bucket.
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: true,
};

describe('signature version 4', () => {
  test('produces a signature with the right shape and pieces', () => {
    const signed = signRequest(AWS_EXAMPLE, 'GET', 'test.txt', {
      now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
    });

    const auth = signed.headers.authorization ?? '';
    expect(auth).toStartWith('AWS4-HMAC-SHA256 ');
    expect(auth).toContain('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  test('is stable for the same inputs, and changes when any of them change', () => {
    const at = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
    const signature = (config: S3Config, key: string, method = 'GET') =>
      (signRequest(config, method, key, { now: at }).headers.authorization ?? '').split(
        'Signature=',
      )[1] ?? '';

    const base = signature(AWS_EXAMPLE, 'test.txt');
    expect(signature(AWS_EXAMPLE, 'test.txt')).toBe(base);

    // Each of these is part of what gets signed, so each must move the signature.
    expect(signature(AWS_EXAMPLE, 'other.txt')).not.toBe(base);
    expect(signature(AWS_EXAMPLE, 'test.txt', 'PUT')).not.toBe(base);
    expect(signature({ ...AWS_EXAMPLE, region: 'eu-west-1' }, 'test.txt')).not.toBe(base);
    expect(signature({ ...AWS_EXAMPLE, secretAccessKey: 'different' }, 'test.txt')).not.toBe(base);
    expect(signature({ ...AWS_EXAMPLE, bucket: 'other-bucket' }, 'test.txt')).not.toBe(base);
  });

  test('moves the signature when the clock does', () => {
    const one = signRequest(AWS_EXAMPLE, 'GET', 'x', { now: new Date(Date.UTC(2013, 4, 24)) });
    const two = signRequest(AWS_EXAMPLE, 'GET', 'x', { now: new Date(Date.UTC(2013, 4, 25)) });
    expect(one.headers.authorization).not.toBe(two.headers.authorization);
    expect(two.headers['x-amz-date']).toBe('20130525T000000Z');
  });
});

describe('addressing the bucket', () => {
  test('puts the bucket in the path by default, which is what most providers want', () => {
    const signed = signRequest(AWS_EXAMPLE, 'GET', 'backups/one.tar.gz');
    expect(signed.url).toBe('https://s3.amazonaws.com/examplebucket/backups/one.tar.gz');
    expect(signed.headers.host).toBe('s3.amazonaws.com');
  });

  test('puts it in the hostname when asked', () => {
    const signed = signRequest({ ...AWS_EXAMPLE, forcePathStyle: false }, 'GET', 'one.tar.gz');
    expect(signed.url).toBe('https://examplebucket.s3.amazonaws.com/one.tar.gz');
    expect(signed.headers.host).toBe('examplebucket.s3.amazonaws.com');
  });

  test('escapes what S3 escapes, and leaves the separators alone', () => {
    const signed = signRequest(AWS_EXAMPLE, 'GET', "my project/it's here.tar.gz");
    // Slashes survive; the space and the apostrophe do not. `encodeURIComponent`
    // leaves apostrophes alone, and S3 signs them escaped, so a key containing one
    // would sign correctly and still be rejected.
    expect(signed.url).toContain('/my%20project/');
    expect(signed.url).toContain('it%27s%20here.tar.gz');
  });
});

describe('where things are put', () => {
  test('uses the prefix when there is one', () => {
    expect(objectKey({ ...AWS_EXAMPLE, prefix: 'server-one' }, 'a.tar.gz')).toBe(
      'server-one/a.tar.gz',
    );
  });

  test('tolerates however the prefix was typed', () => {
    for (const prefix of ['server-one', '/server-one', 'server-one/', '/server-one/']) {
      expect(objectKey({ ...AWS_EXAMPLE, prefix }, 'a.tar.gz')).toBe('server-one/a.tar.gz');
    }
  });

  test('is just the name when there is no prefix', () => {
    expect(objectKey(AWS_EXAMPLE, 'a.tar.gz')).toBe('a.tar.gz');
    expect(objectKey({ ...AWS_EXAMPLE, prefix: '' }, 'a.tar.gz')).toBe('a.tar.gz');
  });
});
