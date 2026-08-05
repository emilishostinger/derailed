import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from '../config.ts';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let key: Buffer | null = null;

/**
 * Loads (or creates) the at-rest encryption key.
 *
 * Honest threat model: this protects the SQLite file if it is copied off the box.
 * It does not protect against someone who is already root on the box. They can
 * read the key file too.
 */
export function loadSecretKey(file: string = paths.secretKey): Buffer {
  if (key) return key;
  if (existsSync(file)) {
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`Secret key at ${file} is corrupt (expected 32 bytes).`);
    }
  } else {
    key = randomBytes(32);
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return key;
}

export function resetSecretKeyCache(): void {
  key = null;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', loadSecretKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', loadSecretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** URL-safe secret, used for database passwords and session ids. */
export function randomSecret(length = 32): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
