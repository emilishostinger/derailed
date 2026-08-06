import { join } from 'node:path';
import { type FreeDomain, topics } from '@derailed/shared';
import { CERTS_DIR_IN_CONTAINER } from '../config.ts';
import { deleteSetting, getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { publish } from '../events/bus.ts';
import { decrypt, encrypt } from '../util/crypto.ts';
import { certificateExpiry, ensureCertificate, needsRenewal } from './acme.ts';
import { hostnameFor, isValidName, normalizeName, pointAtServer } from './duckdns.ts';
import type { LoadedCertificate } from './routes.ts';

/**
 * The free secured address, as one thing.
 *
 * Everything about claiming, renewing and serving `something.duckdns.org` lives here,
 * so the rest of Derailed only ever asks two questions: what is the base domain, and
 * which certificates should Caddy load.
 */

export function freeDomainName(): string | null {
  return getSetting(SETTINGS.freeDomainName);
}

function freeDomainToken(): string | null {
  const stored = getSetting(SETTINGS.freeDomainToken);
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    // A database restored without its key. Saying so beats a puzzling failure later.
    return null;
  }
}

export function freeDomainHostname(): string | null {
  const name = freeDomainName();
  return name ? hostnameFor(name) : null;
}

export async function freeDomainState(): Promise<FreeDomain> {
  const name = freeDomainName();
  if (!name) {
    return { name: null, hostname: null, secured: false, expiresAt: null, error: null };
  }

  const expiresAt = await certificateExpiry(name);
  return {
    name,
    hostname: hostnameFor(name),
    secured: expiresAt !== null && expiresAt > Date.now(),
    expiresAt,
    error: getSetting(SETTINGS.freeDomainError),
  };
}

/**
 * The domain apps get their free addresses under.
 *
 * A domain the person set up themselves wins: they went to the trouble of pointing a
 * wildcard at this server, and their own name is nicer than a borrowed one. The free
 * address is the fallback, and sslip.io the fallback to that.
 */
export function appBaseDomain(): string | null {
  return getSetting(SETTINGS.appBaseDomain) ?? freeDomainHostname();
}

/** Whether this name is covered by the wildcard Derailed holds. */
export function isCoveredByFreeDomain(hostname: string): boolean {
  const base = freeDomainHostname();
  if (!base) return false;
  return hostname === base || hostname.endsWith(`.${base}`);
}

/**
 * The certificates Caddy should load, by the path it will see.
 *
 * Empty unless a certificate is actually on disk: naming a file Caddy cannot open
 * makes it reject the entire configuration, which would take every site down over a
 * feature nobody had finished setting up.
 */
export async function loadedCertificates(): Promise<LoadedCertificate[]> {
  const name = freeDomainName();
  if (!name) return [];
  const expiry = await certificateExpiry(name);
  if (expiry === null) return [];

  const host = hostnameFor(name);
  const base = join(CERTS_DIR_IN_CONTAINER, 'certificates', `_.${host}`);
  return [{ certificate: `${base}.crt`, key: `${base}.key` }];
}

export interface ClaimOptions {
  name: string;
  token: string;
  email: string;
  serverIp: string;
  onLine?: (line: string) => void;
}

export class FreeDomainError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'FreeDomainError';
    this.hint = hint;
  }
}

/**
 * Claims the address and gets the certificate.
 *
 * Ordered so that nothing is remembered until it has been shown to work: the token is
 * proved against DuckDNS before it is stored, and the settings that make Derailed hand
 * out addresses under this name are only written once a certificate exists. A failure
 * half way through therefore leaves a server exactly as it was.
 */
export async function claimFreeDomain(options: ClaimOptions): Promise<FreeDomain> {
  const name = normalizeName(options.name);
  if (!isValidName(name)) {
    throw new FreeDomainError(
      `"${options.name.trim()}" isn't a DuckDNS name.`,
      'Use just the first part, the bit before .duckdns.org.',
    );
  }
  if (!options.token.trim()) {
    throw new FreeDomainError(
      'That DuckDNS token is empty.',
      'It is the long code at the top of your DuckDNS page.',
    );
  }

  options.onLine?.(`Pointing ${hostnameFor(name)} at this server…`);
  await pointAtServer(name, options.token.trim(), options.serverIp);

  await ensureCertificate({
    name,
    token: options.token.trim(),
    email: options.email,
    onLine: options.onLine,
  });

  setSetting(SETTINGS.freeDomainName, name);
  setSetting(SETTINGS.freeDomainToken, encrypt(options.token.trim()));
  setSetting(SETTINGS.freeDomainEmail, options.email);
  deleteSetting(SETTINGS.freeDomainError);

  const expiry = await certificateExpiry(name);
  if (expiry) setSetting(SETTINGS.freeDomainExpiresAt, String(expiry));

  return freeDomainState();
}

/**
 * Gives the address up. The certificate files are left alone: they cost nothing to
 * keep, and if the same name is claimed again within three months there is nothing
 * to ask Let's Encrypt for.
 */
export function releaseFreeDomain(): void {
  for (const key of [
    SETTINGS.freeDomainName,
    SETTINGS.freeDomainToken,
    SETTINGS.freeDomainEmail,
    SETTINGS.freeDomainExpiresAt,
    SETTINGS.freeDomainError,
  ]) {
    deleteSetting(key);
  }
}

/**
 * Keeps the certificate alive, and the address pointed at this server.
 *
 * Both matter: a certificate that expires takes every app offline behind a browser
 * warning, and a server whose public address changed (a rebuild, a new provider, a
 * dynamic IP) is one whose apps all resolve to somebody else's machine.
 *
 * Returns whether Caddy needs reloading.
 */
export async function renewIfNeeded(onLine?: (line: string) => void): Promise<boolean> {
  const name = freeDomainName();
  const token = freeDomainToken();
  if (!name || !token) return false;

  const serverIp = getSetting(SETTINGS.serverIp);
  if (serverIp) await pointAtServer(name, token, serverIp).catch(() => undefined);

  const expiry = await certificateExpiry(name);
  if (!needsRenewal(expiry)) return false;

  try {
    const changed = await ensureCertificate({
      name,
      token,
      email: getSetting(SETTINGS.freeDomainEmail) ?? `admin@${hostnameFor(name)}`,
      onLine,
    });
    deleteSetting(SETTINGS.freeDomainError);
    const fresh = await certificateExpiry(name);
    if (fresh) setSetting(SETTINGS.freeDomainExpiresAt, String(fresh));
    return changed;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The certificate could not be renewed.';
    setSetting(SETTINGS.freeDomainError, message);
    // Worth saying out loud only once it is getting urgent. A first failure with six
    // weeks left is noise; the same failure with five days left is not.
    if (expiry !== null && expiry - Date.now() < 7 * 24 * 60 * 60 * 1000) {
      publish(topics.system, { type: 'notice', level: 'error', message });
    }
    return false;
  }
}

/** Checked twice a day. Renewal starts a month out, so this has sixty tries to work. */
const RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startFreeDomainRenewal(onChange: () => Promise<void> | void): void {
  if (timer) return;
  const tick = async () => {
    const changed = await renewIfNeeded().catch(() => false);
    if (changed) await onChange();
  };
  timer = setInterval(() => void tick(), RENEW_INTERVAL_MS);
  timer.unref?.();
  // Once at boot too: a server that was off for two months has an expired certificate
  // and no reason to wait half a day before doing anything about it.
  void tick();
}

export function stopFreeDomainRenewal(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
