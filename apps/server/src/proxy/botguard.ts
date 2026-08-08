import { createHash, createHmac } from 'node:crypto';
import type { TrafficEvent } from '../analytics/store.ts';
import { listServices } from '../db/repo/services.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { randomSecret } from '../util/crypto.ts';
import { isPrivateAddress } from '../util/net.ts';

/**
 * The bots, blocked.
 *
 * The 2026 complaint: scrapers hammer small sites hard enough that people notice
 * their box working at night. The answer here is deliberately not a gatekeeper in
 * front of every request; Derailed is not in the request path and that is a
 * design decision worth keeping. Instead, the proxy's own access log, which the
 * visitor figures already read every fifteen seconds, feeds a small state
 * machine:
 *
 * - An address going hard enough to look automated is **challenged**: every page
 *   becomes a small proof-of-work that a person's browser solves invisibly in
 *   under a second and a scraper has to pay for, per address, in CPU.
 * - An address going five times harder is plainly a script and is **refused**
 *   for a while, with a 429 that says when to come back.
 * - Solving the challenge earns the address a pass for a few hours: humans meet
 *   the wall at most once an afternoon, and only on a busy day.
 *
 * The honest print: a burst shorter than the log-reading interval gets through
 * before the wall goes up. The bill for sustained hammering, which is the thing
 * people actually complain about, arrives about fifteen seconds in.
 */

export type BotMode = 'off' | 'polite' | 'strict';

/** Requests per minute from one address before the challenge goes up. */
export const CHALLENGE_THRESHOLD: Record<Exclude<BotMode, 'off'>, number> = {
  polite: 240,
  strict: 90,
};

/** Five times the challenge line: nobody's browser, whatever it claims. */
const BAN_MULTIPLIER = 5;

const CHALLENGE_FOR_MS = 60 * 60 * 1000;
const BAN_FOR_MS = 30 * 60 * 1000;
const PASS_FOR_MS = 6 * 60 * 60 * 1000;

interface AddressState {
  minuteStart: number;
  count: number;
  challengedUntil: number;
  bannedUntil: number;
  passUntil: number;
}

const state = new Map<string, Map<string, AddressState>>();

function stateFor(serviceId: string, ip: string): AddressState {
  let addresses = state.get(serviceId);
  if (!addresses) {
    addresses = new Map();
    state.set(serviceId, addresses);
  }
  let address = addresses.get(ip);
  if (!address) {
    address = { minuteStart: 0, count: 0, challengedUntil: 0, bannedUntil: 0, passUntil: 0 };
    addresses.set(ip, address);
  }
  return address;
}

/** For the tests, and for a server that wants to forgive everyone at once. */
export function resetBotGuard(): void {
  state.clear();
}

/**
 * Feeds the guard what the proxy saw. Returns true when the set of walls
 * changed, which is the caller's cue to push new routes.
 */
export function observeTraffic(
  events: TrafficEvent[],
  modeOf: (serviceId: string) => BotMode,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const event of events) {
    const mode = modeOf(event.serviceId);
    if (mode === 'off') continue;
    // Never the machine's own addresses: health checks and the panel would be
    // the first things challenged on a busy day.
    if (!event.ip || isPrivateAddress(event.ip)) continue;

    const address = stateFor(event.serviceId, event.ip);
    if (address.passUntil > now) continue;

    const minute = Math.floor(event.at / 60_000) * 60_000;
    if (minute !== address.minuteStart) {
      address.minuteStart = minute;
      address.count = 0;
    }
    address.count++;

    const threshold = CHALLENGE_THRESHOLD[mode];
    if (address.count > threshold * BAN_MULTIPLIER && address.bannedUntil <= now) {
      address.bannedUntil = now + BAN_FOR_MS;
      changed = true;
    } else if (address.count > threshold && address.challengedUntil <= now) {
      address.challengedUntil = now + CHALLENGE_FOR_MS;
      changed = true;
    }
  }
  return changed;
}

/** The walls currently up for one app, expired entries swept on the way out. */
export function wallsFor(
  serviceId: string,
  now = Date.now(),
): { challenged: string[]; banned: string[] } {
  const addresses = state.get(serviceId);
  const challenged: string[] = [];
  const banned: string[] = [];
  if (!addresses) return { challenged, banned };
  for (const [ip, address] of addresses) {
    if (address.bannedUntil > now) banned.push(ip);
    else if (address.challengedUntil > now && address.passUntil <= now) challenged.push(ip);
  }
  return { challenged: challenged.sort(), banned: banned.sort() };
}

/** A solved challenge: the address is a person's for the next few hours. */
export function grantPass(serviceId: string, ip: string, now = Date.now()): void {
  const address = stateFor(serviceId, ip);
  address.passUntil = now + PASS_FOR_MS;
  address.challengedUntil = 0;
  address.count = 0;
}

/** Whether any wall anywhere has quietly expired since the routes were pushed. */
export function anythingExpired(now = Date.now()): boolean {
  for (const addresses of state.values()) {
    for (const address of addresses.values()) {
      const wasUp = address.bannedUntil > 0 || address.challengedUntil > 0;
      const stillUp = address.bannedUntil > now || address.challengedUntil > now;
      if (wasUp && !stillUp) return true;
    }
  }
  return false;
}

/** Drops rows whose every timer has run out, so the map does not grow for ever. */
export function sweepBotGuard(now = Date.now()): void {
  for (const [serviceId, addresses] of state) {
    for (const [ip, address] of addresses) {
      if (
        address.bannedUntil <= now &&
        address.challengedUntil <= now &&
        address.passUntil <= now
      ) {
        addresses.delete(ip);
      } else {
        // A wall that expired is forgotten as a wall but the row stays for its pass.
        if (address.bannedUntil <= now) address.bannedUntil = 0;
        if (address.challengedUntil <= now) address.challengedUntil = 0;
      }
    }
    if (addresses.size === 0) state.delete(serviceId);
  }
}

// ---------------------------------------------------------------------------
// The proof of work itself.
// ---------------------------------------------------------------------------

/** Leading zero hex digits required of sha256(token + nonce). Sixteen bits: well
 *  under a second for a browser, real money for a scraper doing it per address. */
export const POW_PREFIX = '0000';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function challengeSecret(): string {
  let secret = getSetting(SETTINGS.botChallengeSecret);
  if (!secret) {
    secret = randomSecret(32);
    setSetting(SETTINGS.botChallengeSecret, secret);
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac('sha256', challengeSecret()).update(payload).digest('hex').slice(0, 32);
}

/** A token the page can hold: who it is for, until when, and our signature. */
export function issueChallenge(serviceId: string, ip: string, now = Date.now()): string {
  // Joined with a character an address can never hold; an IP is made of dots.
  const payload = [serviceId, ip, String(now + CHALLENGE_TTL_MS), randomSecret(8)].join('|');
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyChallenge(
  token: string,
  nonce: string,
  serviceId: string,
  ip: string,
  now = Date.now(),
): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let payload = '';
  try {
    payload = Buffer.from(encoded, 'base64url').toString();
  } catch {
    return false;
  }
  if (sign(payload) !== signature) return false;

  const [forService, forIp, expires] = payload.split('|');
  if (forService !== serviceId || forIp !== ip) return false;
  if (Number(expires) < now) return false;
  if (nonce.length > 32) return false;

  const digest = createHash('sha256').update(`${token}${nonce}`).digest('hex');
  return digest.startsWith(POW_PREFIX);
}

/** For the tests and nothing else: grinding the same puzzle the page grinds. */
export function solveChallenge(token: string): string {
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const digest = createHash('sha256').update(`${token}${nonce}`).digest('hex');
    if (digest.startsWith(POW_PREFIX)) return String(nonce);
  }
  throw new Error('unsolvable');
}

/** The mode lookup the collector uses, one query per sweep rather than per line. */
export function currentModes(): (serviceId: string) => BotMode {
  const modes = new Map<string, BotMode>();
  for (const service of listServices()) {
    modes.set(service.id, (service.botMode as BotMode) ?? 'off');
  }
  return (serviceId) => modes.get(serviceId) ?? 'off';
}
