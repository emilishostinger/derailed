import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt, loadSecretKey, randomSecret } from '../src/util/crypto.ts';
import { slugify, uniqueSlug } from '../src/util/ids.ts';

describe('slugify', () => {
  test('makes names safe for hostnames and container names', () => {
    expect(slugify('My Web App!')).toBe('my-web-app');
    expect(slugify('  Trailing --- dashes  ')).toBe('trailing-dashes');
    expect(slugify('Ünïcödé Ãpp')).toBe('unicode-app');
    expect(slugify('123')).toBe('123');
    expect(slugify('!!!')).toBe('service');
    expect(slugify('!!!', 'db')).toBe('db');
  });

  test('never ends with a dash after truncation', () => {
    const slug = slugify(`${'a'.repeat(39)} bcdef`);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe('uniqueSlug', () => {
  test('suffixes until free', () => {
    const taken = new Set(['web', 'web-2']);
    expect(uniqueSlug('web', (s) => taken.has(s))).toBe('web-3');
    expect(uniqueSlug('api', (s) => taken.has(s))).toBe('api');
  });
});

describe('secrets at rest', () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), 'derailed-key-')), 'secret.key');

  test('round-trips values', () => {
    loadSecretKey(keyFile);
    const secret = 'postgres://user:p@ssw0rd@db:5432/app';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  test('produces a different ciphertext each time', () => {
    loadSecretKey(keyFile);
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  test('rejects tampered ciphertext', () => {
    loadSecretKey(keyFile);
    const encoded = encrypt('important');
    const raw = Buffer.from(encoded, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  test('random secrets are url-safe and unique', () => {
    const values = new Set(Array.from({ length: 200 }, () => randomSecret(32)));
    expect(values.size).toBe(200);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});
