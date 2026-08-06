import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FriendlyError } from '../build/git.ts';
import { paths } from '../config.ts';
import { hostnameFor, normalizeName } from './duckdns.ts';

/**
 * One certificate for every app, now and for ever.
 *
 * Caddy issues certificates on its own and does it well, but only over HTTP, which
 * means every app's address has to be publicly resolvable before it can be secured,
 * and every app costs one certificate. A wildcard is a better deal in every way: it
 * is proved once by writing a DNS record, it covers names that do not exist yet, and
 * it is a single certificate no matter how many apps end up behind it.
 *
 * Proving a name over DNS needs a client that speaks to the DNS provider, and the
 * stock `caddy:2-alpine` image ships no DNS modules. Rather than build and publish a
 * bespoke Caddy image — a supply chain of our own for everyone to trust — Derailed
 * fetches `lego`, a single static binary, exactly the way it already fetches its
 * builder. Caddy is then handed the finished certificate to serve.
 *
 * The side effect is that the same code path reaches a hundred other DNS providers,
 * so "use my real domain, via Cloudflare" is later a table of provider names rather
 * than a second implementation.
 */
const PINNED_VERSION = '5.3.1';
const RELEASES = 'https://github.com/go-acme/lego/releases';

/**
 * Taken from the release's own `lego_5.3.1_checksums.txt`.
 *
 * This binary runs as root and holds the key to every certificate the server serves,
 * so it gets the same treatment as the builder and as Derailed's own update: what
 * arrives is checked against what was expected, and thrown away rather than run if it
 * does not match. There is deliberately no "fall back to the newest release": a pin
 * that stops pinning the moment an asset moves is not a pin.
 */
const PINNED_DIGESTS: Record<string, string> = {
  linux_amd64: 'b3c71b122ee1947eacfe0b809b955647f6377239fe4bfc49f73b1a091ae1252a',
  linux_arm64: '58db563a2b97c2259516fa9910b4a9e1634a0737723d0381a65af1bf93a4b433',
  darwin_amd64: '97516d24b7c7858918b3b6cdab6a73c0197fb73cd02b6c354bb48b7f0518e252',
  darwin_arm64: '8b0669aaaeb0fceaec99406780bb6f274e67b0cf743cfd53d9e5c6535f250963',
};

/** Renew with this much life left, so a failure has three weeks of retries in it. */
const RENEW_WITHIN_DAYS = 30;

export function legoBinaryPath(): string {
  return join(paths.bin, 'lego');
}

export function legoTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${platform}_${arch}`;
}

export function expectedDigest(target: string = legoTarget()): string | null {
  return PINNED_DIGESTS[target] ?? null;
}

async function download(onLine?: (line: string) => void): Promise<void> {
  const target = legoTarget();
  const expected = expectedDigest(target);
  if (!expected) {
    throw new FriendlyError(
      `Derailed has no checked build of its certificate tool for ${target}.`,
      'Your apps will keep working on their unsecured addresses. Point a domain at this server to get a padlock another way.',
    );
  }

  const asset = `lego_v${PINNED_VERSION}_${target}.tar.gz`;
  const url = `${RELEASES}/download/v${PINNED_VERSION}/${asset}`;
  onLine?.(`Downloading the certificate tool (lego ${PINNED_VERSION})…`);

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) {
    throw new FriendlyError(
      `Derailed couldn't download the certificate tool (HTTP ${response.status}).`,
      'Check that this server has internet access, then try again.',
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new FriendlyError(
      "The certificate tool Derailed downloaded wasn't the one it expected, so it was thrown away.",
      'Nothing was installed and nothing was changed. This is worth reporting.',
    );
  }

  const tmp = join(paths.bin, `lego-${PINNED_VERSION}.tar.gz`);
  await Bun.write(tmp, bytes);
  const proc = Bun.spawn(['tar', '-xzf', tmp, '-C', paths.bin, 'lego'], { stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  await rm(tmp, { force: true });
  if (code !== 0) {
    throw new FriendlyError("Couldn't unpack the certificate tool.", undefined, [stderr]);
  }
  chmodSync(legoBinaryPath(), 0o755);
}

let ensuring: Promise<string> | null = null;

export function ensureLego(onLine?: (line: string) => void): Promise<string> {
  const binary = legoBinaryPath();
  if (existsSync(binary)) return Promise.resolve(binary);

  ensuring ??= (async () => {
    await mkdir(paths.bin, { recursive: true });
    await download(onLine);
    return binary;
  })().finally(() => {
    ensuring = null;
  });

  return ensuring;
}

/**
 * Where lego puts what it makes. A wildcard's files are named after the domain with
 * the star replaced by an underscore, which is lego's convention and not ours.
 */
export function certificatePaths(name: string): { cert: string; key: string } {
  const host = hostnameFor(name);
  const base = join(paths.certs, 'certificates', `_.${host}`);
  return { cert: `${base}.crt`, key: `${base}.key` };
}

export function certificateExists(name: string): boolean {
  const { cert, key } = certificatePaths(name);
  return existsSync(cert) && existsSync(key);
}

/**
 * When the certificate on disk stops being valid, or null if there isn't one.
 *
 * Read out of the certificate itself rather than remembered in a setting, so a file
 * restored from a backup, replaced by hand, or left behind by an older version is
 * still understood correctly.
 */
export async function certificateExpiry(name: string): Promise<number | null> {
  const { cert } = certificatePaths(name);
  if (!existsSync(cert)) return null;
  try {
    return parseNotAfter(await Bun.file(cert).text());
  } catch {
    return null;
  }
}

/**
 * Pulls the expiry date out of a PEM certificate.
 *
 * Bun has no certificate parser, and pulling in an X.509 library to read one date
 * would be a dependency for a field at a fixed offset in a structure that has not
 * changed since 1988. The validity period is the second date in the TBS block; both
 * are ASN.1 UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`).
 */
export function parseNotAfter(pem: string): number | null {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }

  const dates: number[] = [];
  for (let i = 0; i + 1 < der.length; i++) {
    const tag = der[i];
    // 0x17 UTCTime, 0x18 GeneralizedTime. Both are followed by a short-form length.
    if (tag !== 0x17 && tag !== 0x18) continue;
    const length = der[i + 1] ?? 0;
    if (length < 11 || length > 32 || i + 2 + length > der.length) continue;

    const text = new TextDecoder().decode(der.subarray(i + 2, i + 2 + length));
    if (!/^\d{12,14}Z$/.test(text)) continue;

    const digits = tag === 0x17 ? `${Number(text.slice(0, 2)) < 50 ? '20' : '19'}${text}` : text;
    const parsed = Date.UTC(
      Number(digits.slice(0, 4)),
      Number(digits.slice(4, 6)) - 1,
      Number(digits.slice(6, 8)),
      Number(digits.slice(8, 10)),
      Number(digits.slice(10, 12)),
      Number(digits.slice(12, 14) || '0'),
    );
    if (!Number.isNaN(parsed)) dates.push(parsed);
    // The two validity dates come first and together; anything later is an extension.
    if (dates.length === 2) break;
  }

  return dates.length === 2 ? (dates[1] ?? null) : null;
}

export function needsRenewal(expiresAt: number | null, now = Date.now()): boolean {
  if (expiresAt === null) return true;
  return expiresAt - now < RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000;
}

interface IssueOptions {
  name: string;
  token: string;
  /** Let's Encrypt wants somewhere to warn about expiry. Only ever sent to them. */
  email: string;
  onLine?: (line: string) => void;
}

/**
 * Asks for (or renews) the wildcard, proving the name over DNS.
 *
 * `renew` rather than `run` once something is already on disk: `run` would ask for a
 * brand new certificate every time and burn the weekly allowance in a fortnight.
 */
async function runLego(options: IssueOptions, mode: 'run' | 'renew'): Promise<void> {
  const binary = await ensureLego(options.onLine);
  const host = hostnameFor(options.name);

  const args = [
    '--accept-tos',
    '--email',
    options.email,
    '--dns',
    'duckdns',
    // Both halves: the wildcard covers `anything.name.duckdns.org` but pointedly not
    // `name.duckdns.org` itself, and the bare name is the one a person is most likely
    // to type into a browser.
    '--domains',
    `*.${host}`,
    '--domains',
    host,
    '--path',
    paths.certs,
    mode,
  ];
  if (mode === 'renew') args.push('--days', String(RENEW_WITHIN_DAYS));

  const proc = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      DUCKDNS_TOKEN: options.token,
      // DuckDNS serves the TXT record from its own nameservers immediately, but the
      // resolver lego checks with may still be holding the old answer. Ask DuckDNS
      // directly and the wait is seconds rather than minutes.
      DUCKDNS_PROPAGATION_TIMEOUT: '300',
      DUCKDNS_POLLING_INTERVAL: '5',
    },
  });

  const timer = setTimeout(() => proc.kill(), 600_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const output = `${stdout}\n${stderr}`;
  for (const line of output.split('\n')) {
    if (line.trim()) options.onLine?.(line.trimEnd());
  }

  if (code !== 0) throw explain(output, host);
}

/**
 * Turns lego's output into something worth reading.
 *
 * Every branch here is a failure seen in practice, and the hint is what the person
 * has to do next rather than what went wrong internally.
 */
function explain(output: string, host: string): FriendlyError {
  const tail = output.split('\n').filter(Boolean).slice(-12);

  if (/rateLimited|too many certificates|rate limit/i.test(output)) {
    return new FriendlyError(
      `Let's Encrypt is rate limiting ${host} at the moment.`,
      'This resets within a week. Your apps keep working on their unsecured addresses until then, and Derailed will keep trying.',
      tail,
    );
  }
  if (/unauthorized|incorrect TXT|no TXT record|DNS problem/i.test(output)) {
    return new FriendlyError(
      "Let's Encrypt couldn't see the record proving you own that address.",
      'This is nearly always a DuckDNS token that has been regenerated since it was pasted in. Copy it again from duckdns.org and try once more.',
      tail,
    );
  }
  if (/timeout|deadline exceeded|no such host|connection refused/i.test(output)) {
    return new FriendlyError(
      "Derailed couldn't finish talking to Let's Encrypt.",
      'Usually a network hiccup. It will try again by itself within the hour.',
      tail,
    );
  }
  return new FriendlyError(
    `Derailed couldn't get a certificate for ${host}.`,
    'Your apps keep working on their unsecured addresses. The details below are from the certificate tool.',
    tail,
  );
}

/**
 * Gets a certificate if there is none, renews it if it is close to expiring, and does
 * nothing at all if it is healthy. Safe to call on a timer and at every boot.
 *
 * Returns whether anything was written, so the caller only reloads Caddy when there
 * is something new for it to serve.
 */
export async function ensureCertificate(options: IssueOptions): Promise<boolean> {
  const name = normalizeName(options.name);
  await mkdir(paths.certs, { recursive: true, mode: 0o700 });

  if (!certificateExists(name)) {
    options.onLine?.(`Asking Let's Encrypt for a certificate covering ${hostnameFor(name)}…`);
    await runLego({ ...options, name }, 'run');
    return true;
  }

  const expiry = await certificateExpiry(name);
  if (!needsRenewal(expiry)) return false;

  options.onLine?.('Renewing the certificate…');
  await runLego({ ...options, name }, 'renew');
  return true;
}
