import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OffsiteSettings, OffsiteStatus } from '@derailed/shared';
import { deleteSetting, getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { decrypt, encrypt } from '../util/crypto.ts';
import { backupFile } from './backup.ts';
import {
  deleteObject,
  listObjects,
  putObject,
  type RemoteObject,
  type S3Config,
  S3Error,
  testConnection,
} from './s3.ts';

/**
 * Backups that leave the building.
 *
 * A backup on the same disk as the thing it is backing up is a copy, not a backup.
 * The failure that actually eats people's data is losing the whole server: the disk
 * fails, the provider closes the account, someone rebuilds the wrong machine. In every
 * one of those the local `.tar.gz` files go at the same moment as the originals.
 *
 * Only S3-compatible storage is supported, and deliberately so: it is the one
 * interface every cheap provider speaks, so one implementation reaches Backblaze B2,
 * Cloudflare R2, Wasabi, Storj, MinIO, Hetzner and AWS. A second protocol would be a
 * second thing to keep working for no additional provider.
 */

export function offsiteConfig(): S3Config | null {
  const endpoint = getSetting(SETTINGS.offsiteEndpoint);
  const bucket = getSetting(SETTINGS.offsiteBucket);
  const accessKeyId = getSetting(SETTINGS.offsiteAccessKey);
  const secretEnc = getSetting(SETTINGS.offsiteSecretKey);
  if (!endpoint || !bucket || !accessKeyId || !secretEnc) return null;

  let secretAccessKey: string;
  try {
    secretAccessKey = decrypt(secretEnc);
  } catch {
    // A database restored without its key file. Nothing can be done with the stored
    // secret, and pretending it is configured would mean silent failures for ever.
    return null;
  }

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: getSetting(SETTINGS.offsiteRegion) ?? 'us-east-1',
    prefix: getSetting(SETTINGS.offsitePrefix) ?? '',
    forcePathStyle: getSetting(SETTINGS.offsitePathStyle) !== 'false',
  };
}

export function offsiteEnabled(): boolean {
  return offsiteConfig() !== null;
}

/** What the settings page shows. The secret is never among it. */
export function offsiteSettings(): OffsiteSettings {
  return {
    endpoint: getSetting(SETTINGS.offsiteEndpoint) ?? '',
    bucket: getSetting(SETTINGS.offsiteBucket) ?? '',
    region: getSetting(SETTINGS.offsiteRegion) ?? 'us-east-1',
    accessKeyId: getSetting(SETTINGS.offsiteAccessKey) ?? '',
    prefix: getSetting(SETTINGS.offsitePrefix) ?? '',
    pathStyle: getSetting(SETTINGS.offsitePathStyle) !== 'false',
    /** Whether a secret is stored, never the secret itself. */
    hasSecret: !!getSetting(SETTINGS.offsiteSecretKey),
  };
}

export interface SaveOffsiteInput {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  /** Omitted when the stored one is being kept. */
  secretAccessKey?: string;
  prefix?: string;
  pathStyle?: boolean;
}

export function saveOffsiteSettings(input: SaveOffsiteInput): void {
  setSetting(SETTINGS.offsiteEndpoint, input.endpoint.trim().replace(/\/+$/, ''));
  setSetting(SETTINGS.offsiteBucket, input.bucket.trim());
  setSetting(SETTINGS.offsiteRegion, input.region.trim() || 'us-east-1');
  setSetting(SETTINGS.offsiteAccessKey, input.accessKeyId.trim());
  setSetting(SETTINGS.offsitePrefix, (input.prefix ?? '').trim());
  setSetting(SETTINGS.offsitePathStyle, input.pathStyle === false ? 'false' : 'true');
  // Only replaced when a new one is given, so saving the form without retyping the
  // secret keeps the stored one rather than wiping it.
  if (input.secretAccessKey?.trim()) {
    setSetting(SETTINGS.offsiteSecretKey, encrypt(input.secretAccessKey.trim()));
  }
}

export function forgetOffsiteSettings(): void {
  for (const key of [
    SETTINGS.offsiteEndpoint,
    SETTINGS.offsiteBucket,
    SETTINGS.offsiteRegion,
    SETTINGS.offsiteAccessKey,
    SETTINGS.offsiteSecretKey,
    SETTINGS.offsitePrefix,
    SETTINGS.offsitePathStyle,
    SETTINGS.offsiteLastError,
    SETTINGS.offsiteLastCopyAt,
  ]) {
    deleteSetting(key);
  }
}

/** Writes a file, reads it back, compares, removes it. See `testConnection`. */
export async function testOffsite(config?: S3Config): Promise<{ roundTripMs: number }> {
  const target = config ?? offsiteConfig();
  if (!target) {
    throw new S3Error('No off-site storage is set up yet.', 0);
  }
  const { roundTripMs } = await testConnection(target);
  return { roundTripMs };
}

/**
 * Sends one finished backup off the machine.
 *
 * The file is handed over whole rather than as a stream, which sounds like the wrong
 * choice and is not. S3 requires `Content-Length` on an upload and refuses a chunked
 * one with `411 MissingContentLength`; a `ReadableStream` has no length to declare,
 * so streaming it fails outright. A `BunFile` has a known size, so the header is set
 * and the body is still read off disk a piece at a time rather than into memory,
 * which is what actually matters on a server with a gigabyte of it.
 */
export async function copyOffsite(backupId: string): Promise<{ sizeBytes: number } | null> {
  const config = offsiteConfig();
  if (!config) return null;

  const file = backupFile(backupId);
  const info = await stat(file);

  try {
    await putObject(config, basename(file), Bun.file(file), 'application/gzip');
    setSetting(SETTINGS.offsiteLastCopyAt, String(Date.now()));
    deleteSetting(SETTINGS.offsiteLastError);
    return { sizeBytes: info.size };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The copy failed.';
    setSetting(SETTINGS.offsiteLastError, message);
    throw err;
  }
}

/**
 * Keeps the same number of copies off-site as locally.
 *
 * Deliberately never runs when the local retention is set to keep everything: a
 * remote sweep that deletes what the local policy would have kept is a surprise, and
 * this is the one part of the system whose entire job is not surprising anyone.
 */
export async function pruneOffsite(keep: number): Promise<number> {
  const config = offsiteConfig();
  if (!config || keep <= 0) return 0;

  const objects = await listObjects(config);
  const doomed = objects.slice(keep);
  for (const object of doomed) {
    await deleteObject(config, object.name).catch(() => undefined);
  }
  return doomed.length;
}

export async function listOffsite(): Promise<RemoteObject[]> {
  const config = offsiteConfig();
  if (!config) return [];
  return listObjects(config);
}

export async function offsiteStatus(): Promise<OffsiteStatus> {
  const config = offsiteConfig();
  if (!config) {
    return { configured: false, copies: 0, newestAt: null, totalBytes: 0, error: null };
  }

  try {
    const objects = await listObjects(config);
    return {
      configured: true,
      copies: objects.length,
      newestAt: objects[0]?.modifiedAt ?? null,
      totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
      error: getSetting(SETTINGS.offsiteLastError),
    };
  } catch (err) {
    return {
      configured: true,
      copies: 0,
      newestAt: null,
      totalBytes: 0,
      error: err instanceof Error ? err.message : 'Could not reach the storage provider.',
    };
  }
}
