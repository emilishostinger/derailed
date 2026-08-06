import { resolveMx, reverse } from 'node:dns/promises';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { type Mail, type MailAccount, MailError, sendMail } from './smtp.ts';

/**
 * Sending mail from this server, with nothing else set up.
 *
 * The appeal is obvious: there is a server right here, so why ask anyone for a mail
 * provider. The reason is deliverability rather than capability.
 *
 * Two things have to be true, and on most rented servers neither is. Outbound port
 * 25 has to be open, which nearly every provider blocks by default because it is how
 * spam leaves a network. And the address has to have a reverse DNS name, because a
 * message from an IP with no PTR is refused outright by most receivers before its
 * contents are looked at. SPF and DKIM matter too, and cannot be arranged from here
 * at all.
 *
 * So this is offered, and it is checked before it is offered, and when the check
 * fails it says so instead of accepting settings that will silently deliver nothing.
 * A notifier that quietly stops working is worse than one that was never turned on.
 */

/** What this server can and cannot do about mail, worked out rather than assumed. */
export interface DirectCheck {
  usable: boolean;
  /** Outbound 25 reaches a real mail server. */
  port25: boolean;
  /** This address has a reverse DNS name, which receivers insist on. */
  reverseDns: string | null;
  ip: string | null;
  /** Said in the interface, in the order someone would need to act on it. */
  reason: string | null;
}

/** Somewhere certain to have working MX records, for the outbound test. */
const PROBE_DOMAIN = 'gmail.com';

function reachable(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** The name to announce in EHLO. A bare hostname is refused by a lot of receivers. */
export function ourHostname(): string {
  return getSetting(SETTINGS.panelDomain) || hostname();
}

export async function checkDirectDelivery(): Promise<DirectCheck> {
  const ip = getSetting(SETTINGS.serverIp);

  const [mx, ptr] = await Promise.all([
    resolveMx(PROBE_DOMAIN).catch(() => []),
    ip ? reverse(ip).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);

  const target = mx.sort((a, b) => a.priority - b.priority)[0]?.exchange;
  const port25 = target ? await reachable(target, 25) : false;
  return verdict({ port25, reverseDns: ptr[0] ?? null, ip });
}

/**
 * The reading of those two facts, kept apart from the I/O that gathers them.
 *
 * Order matters: an unblocked port is no use without a name to go with it, but
 * being told about reverse DNS while port 25 is shut is advice you cannot act on
 * yet. Whichever has to be fixed first is the one it mentions.
 */
export function verdict(facts: {
  port25: boolean;
  reverseDns: string | null;
  ip: string | null;
}): DirectCheck {
  const { port25, reverseDns, ip } = facts;
  let reason: string | null = null;
  if (!port25) {
    reason =
      'This server cannot reach anything on port 25, which is how mail is delivered. Almost every hosting provider blocks it by default and will unblock it if you ask.';
  } else if (!reverseDns) {
    reason = `Nothing on port 25 is blocked, but ${ip ?? 'this address'} has no reverse DNS name. Most receivers refuse mail from an address without one. Your provider sets this, usually in the same panel as the server itself.`;
  }
  return { usable: port25 && reverseDns !== null, port25, reverseDns, ip, reason };
}

/** The mail servers that accept mail for an address, best first. */
export async function mxFor(address: string): Promise<string[]> {
  const domain = address.split('@')[1];
  if (!domain) return [];
  const records = await resolveMx(domain).catch(() => []);
  if (records.length) {
    return records.sort((a, b) => a.priority - b.priority).map((record) => record.exchange);
  }
  // A domain with no MX takes mail at its A record. Rare, and in the RFC.
  return [domain];
}

/**
 * Hands the message straight to the recipient's mail server.
 *
 * TLS here is opportunistic and unverified on purpose. A receiving MX presents a
 * certificate for its own name, which almost never matches the name its MX record
 * gave, so insisting on a valid certificate would refuse to deliver to most of the
 * internet. Unverified encryption is what RFC 7435 asks for in exactly this case,
 * and it is strictly better than the cleartext alternative. The relay path, where
 * a password is being handed over, stays strict.
 */
export async function sendDirect(from: MailAccount, mail: Mail): Promise<void> {
  const hosts = await mxFor(mail.to);
  if (!hosts.length) {
    throw new MailError(
      `Could not find a mail server for ${mail.to}.`,
      'The domain has no MX record, so there is nowhere to deliver it.',
    );
  }

  const failures: string[] = [];
  for (const host of hosts.slice(0, 3)) {
    try {
      await sendMail(
        { ...from, host, port: 25, security: 'starttls', username: null, password: null },
        mail,
        { ehlo: ourHostname(), opportunistic: true },
      );
      return;
    } catch (error) {
      failures.push(`${host}: ${(error as Error).message}`);
    }
  }

  throw new MailError(
    `No mail server for ${mail.to} would take the message.`,
    failures.join('  |  '),
  );
}
