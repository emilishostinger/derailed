import { createHash, createHmac } from 'node:crypto';

/**
 * Just enough S3 to put a backup somewhere else.
 *
 * "S3-compatible" is the one storage interface every cheap provider speaks, so one
 * implementation reaches Backblaze B2, Cloudflare R2, Wasabi, Storj, MinIO, Hetzner
 * and AWS itself. That is why this exists rather than a list of provider integrations.
 *
 * It is written out by hand rather than pulled in as an SDK. The AWS SDK is tens of
 * megabytes for four HTTP requests, and Derailed ships as one binary that people are
 * asked to trust; signing a request is ninety lines and no supply chain at all.
 */

export interface S3Config {
  /** e.g. `https://s3.eu-central-003.backblazeb2.com`, or AWS's own. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional folder inside the bucket, so one bucket can hold several servers. */
  prefix?: string;
  /**
   * Most providers other than AWS want `endpoint/bucket/key` rather than
   * `bucket.endpoint/key`. Getting this wrong is a 404 that looks like a missing
   * bucket, so it is a setting rather than a guess.
   */
  forcePathStyle?: boolean;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20240115T093000Z` and `20240115`, which is what SigV4 wants. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Percent-encodes a key the way S3 expects: every character escaped except the
 * unreserved set, and `/` left alone because it separates path segments.
 *
 * `encodeURIComponent` is close but leaves `!'()*` alone, and S3 signs those escaped,
 * so a key containing an apostrophe would sign correctly and be rejected.
 */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

export function objectKey(config: S3Config, name: string): string {
  const prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${name}` : name;
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Signs one request with AWS Signature Version 4.
 *
 * The payload hash is `UNSIGNED-PAYLOAD` rather than a digest of the body. A backup
 * can be gigabytes, and signing it properly would mean hashing the whole thing in
 * memory before sending a byte of it. Every S3-compatible provider accepts this over
 * HTTPS, which is where the integrity guarantee actually comes from.
 */
export function signRequest(
  config: S3Config,
  method: string,
  key: string,
  options: { query?: Record<string, string>; now?: Date; headers?: Record<string, string> } = {},
): SignedRequest {
  const endpoint = new URL(config.endpoint);
  const pathStyle = config.forcePathStyle ?? true;

  const host = pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = pathStyle
    ? `/${config.bucket}${key ? `/${encodeKey(key)}` : ''}`
    : `/${encodeKey(key)}`;

  const { amzDate, dateStamp } = stamps(options.now ?? new Date());

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': UNSIGNED_PAYLOAD,
    'x-amz-date': amzDate,
    ...options.headers,
  };

  // Both lists must be sorted by lowercased header name, and must agree.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name] ?? findHeader(headers, name)).trim()}\n`)
    .join('');
  const signedHeaders = names.join(';');

  const query = options.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(query[name] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');

  return {
    url: `${endpoint.protocol}//${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** Header lookup that ignores case, since callers may pass any casing. */
function findHeader(headers: Record<string, string>, lower: string): string {
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === lower);
  return match?.[1] ?? '';
}

export class S3Error extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.hint = hint;
  }
}

/**
 * Turns a status code into something worth reading.
 *
 * Every one of these is a mistake somebody actually makes while filling in the form,
 * and the raw XML that S3 returns names none of them usefully.
 */
async function explain(response: Response, config: S3Config): Promise<S3Error> {
  const body = await response.text().catch(() => '');
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '';

  if (response.status === 403 || code === 'SignatureDoesNotMatch') {
    return new S3Error(
      'The storage provider refused those keys.',
      response.status,
      'Check the access key and secret. If they are right, check the region matches the bucket.',
    );
  }
  if (response.status === 404 || code === 'NoSuchBucket') {
    return new S3Error(
      `The bucket "${config.bucket}" was not found at that address.`,
      response.status,
      'Check the bucket name and the endpoint. Most providers other than AWS also need the path-style setting left on.',
    );
  }
  if (code === 'InvalidAccessKeyId') {
    return new S3Error('That access key does not exist.', response.status);
  }
  if (response.status === 301 || code === 'PermanentRedirect') {
    return new S3Error(
      'That bucket lives in a different region.',
      response.status,
      'Correct the region, or use the endpoint the provider gives for this bucket.',
    );
  }
  return new S3Error(
    `The storage provider answered ${response.status}.`,
    response.status,
    body.slice(0, 200) || undefined,
  );
}

async function send(
  config: S3Config,
  method: string,
  key: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<Response> {
  const { query, ...rest } = init;
  const signed = signRequest(config, method, key, { query });

  const response = await fetch(signed.url, {
    ...rest,
    method,
    headers: { ...signed.headers, ...(rest.headers as Record<string, string>) },
  });

  if (!response.ok) throw await explain(response, config);
  return response;
}

export async function putObject(
  config: S3Config,
  name: string,
  body: Uint8Array | ReadableStream | Blob,
  contentType = 'application/octet-stream',
): Promise<void> {
  await send(config, 'PUT', objectKey(config, name), {
    body,
    headers: { 'content-type': contentType },
    // Required for a streamed body, which is how a multi-gigabyte backup is sent
    // without first being read into the memory of a server that does not have it.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit & { query?: Record<string, string> });
}

export async function getObject(config: S3Config, name: string): Promise<Uint8Array> {
  const response = await send(config, 'GET', objectKey(config, name));
  return new Uint8Array(await response.arrayBuffer());
}

export async function deleteObject(config: S3Config, name: string): Promise<void> {
  await send(config, 'DELETE', objectKey(config, name));
}

export interface RemoteObject {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Lists what is in the prefix. Enough for retention; not a general-purpose lister. */
export async function listObjects(config: S3Config): Promise<RemoteObject[]> {
  // `objectKey(config, '')` already ends in the separator, so the names that come
  // back are stripped against that directly. Appending another slash was the bug
  // here first time round, and it showed up as every name still carrying its folder.
  const prefix = objectKey(config, '');
  const response = await send(config, 'GET', '', {
    query: { 'list-type': '2', ...(prefix ? { prefix } : {}), 'max-keys': '1000' },
  });
  const xml = await response.text();

  const objects: RemoteObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const entry = match[1] ?? '';
    const key = entry.match(/<Key>([^<]+)<\/Key>/)?.[1];
    if (!key) continue;
    objects.push({
      name: prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
      sizeBytes: Number(entry.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
      modifiedAt: Date.parse(entry.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '') || 0,
    });
  }
  return objects.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Writes a small file, reads it back, checks it matches, and removes it.
 *
 * Every one of those steps is a different permission, and a provider will happily
 * accept credentials that can write and not read. Testing only the write is how
 * someone discovers on the worst possible day that their backups were never readable.
 */
export async function testConnection(config: S3Config): Promise<{ ok: true; roundTripMs: number }> {
  const name = `derailed-write-test-${Date.now()}`;
  const payload = new TextEncoder().encode(`Derailed connection test, ${new Date().toISOString()}`);
  const started = Date.now();

  await putObject(config, name, payload, 'text/plain');

  let readBack: Uint8Array;
  try {
    readBack = await getObject(config, name);
  } catch (err) {
    await deleteObject(config, name).catch(() => undefined);
    if (err instanceof S3Error) {
      throw new S3Error(
        'Derailed could write to that bucket but could not read back what it wrote.',
        err.status,
        'The keys need read access as well as write, or a restore would not be possible.',
      );
    }
    throw err;
  }

  const roundTripMs = Date.now() - started;

  if (new TextDecoder().decode(readBack) !== new TextDecoder().decode(payload)) {
    await deleteObject(config, name).catch(() => undefined);
    throw new S3Error('What came back was not what was sent.', 0);
  }

  try {
    await deleteObject(config, name);
  } catch (err) {
    if (err instanceof S3Error) {
      throw new S3Error(
        'Derailed could write and read, but could not delete.',
        err.status,
        'Without delete permission, old backups will pile up for ever. Add it, or set the number to keep to zero and manage them yourself.',
      );
    }
    throw err;
  }

  return { ok: true, roundTripMs };
}
