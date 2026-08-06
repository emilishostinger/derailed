import { FriendlyError } from '../build/git.ts';

/**
 * A free address that can hold a real certificate.
 *
 * The generated sslip.io name every app gets is a working URL and nothing more: it
 * can never be secured. sslip.io is not on the Public Suffix List, so as far as Let's
 * Encrypt is concerned every sslip.io address in the world shares one weekly
 * allowance, and that allowance is routinely exhausted by strangers.
 *
 * duckdns.org *is* on the list. That single fact changes everything: a DuckDNS name
 * is treated as a registered domain of its own, with its own allowance, so asking for
 * a certificate on one is asking for a certificate on something nobody else can spend.
 * It is free, it takes a minute to claim, and unlike a tunnel there is no third party
 * between a visitor and the server.
 *
 * DuckDNS's whole API is one URL that answers `OK` or `KO`. No JSON, no status codes
 * worth reading: a wrong token is a 200 that says `KO`, so the body is the result.
 */
const ENDPOINT = 'https://www.duckdns.org/update';

/** Long enough to cross a slow link, short enough not to hang a deploy. */
const TIMEOUT_MS = 15_000;

/**
 * The bare name, without the `.duckdns.org`. People paste it both ways and the API
 * accepts only one of them, so this is where that stops being anyone else's problem.
 */
export function normalizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.duckdns\.org\.?$/, '');
}

/**
 * What a DuckDNS name is allowed to look like, so a typo fails here and not later.
 *
 * One DNS label: letters, digits and hyphens, not starting or ending with a hyphen,
 * up to 63 characters. The inner range is `{0,61}` rather than `{1,61}` so that
 * two-character names are accepted; they are perfectly legal, and rejecting a name
 * DuckDNS would have handed over is worse than accepting one it refuses, which fails
 * with DuckDNS's own answer a second later anyway.
 */
export function isValidName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

export function hostnameFor(name: string): string {
  return `${normalizeName(name)}.duckdns.org`;
}

async function call(params: Record<string, string>): Promise<string> {
  const url = new URL(ENDPOINT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new FriendlyError(
      "Derailed couldn't reach DuckDNS.",
      'Check that this server has internet access, then try again.',
    );
  }
  return (await response.text()).trim();
}

/**
 * Points the name at this server, which is also the only way to find out whether the
 * token is right. DuckDNS has no "check my token" endpoint, and pointing a name you
 * own at the machine you are setting up is what you wanted anyway.
 */
export async function pointAtServer(name: string, token: string, ip: string): Promise<void> {
  const body = await call({ domains: normalizeName(name), token, ip });
  if (!body.startsWith('OK')) {
    throw new FriendlyError(
      `DuckDNS wouldn't accept that name and token together.`,
      'Check the name is one listed on your DuckDNS page, and that the token is the one shown at the top of it.',
    );
  }
}

/**
 * Writes the TXT record Let's Encrypt reads to prove you control the name.
 *
 * Every subdomain of a DuckDNS name shares one TXT record, which would be a problem
 * if two certificates were ever requested at once. Derailed asks for exactly one, a
 * wildcard covering everything, so the limitation costs nothing.
 */
export async function setChallengeRecord(
  name: string,
  token: string,
  value: string,
): Promise<void> {
  const body = await call({ domains: normalizeName(name), token, txt: value });
  if (!body.startsWith('OK')) {
    throw new FriendlyError(
      "DuckDNS wouldn't accept the record needed to prove you own the address.",
      'This is usually a token that has been regenerated since it was pasted in. Copy it again from duckdns.org.',
    );
  }
}

export async function clearChallengeRecord(name: string, token: string): Promise<void> {
  // Best effort: a leftover TXT record is untidy but harmless, and failing a whole
  // certificate renewal over the tidying up would not be.
  await call({ domains: normalizeName(name), token, txt: '', clear: 'true' }).catch(
    () => undefined,
  );
}
