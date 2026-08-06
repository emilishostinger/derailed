import { once } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

/**
 * Just enough SMTP to send a message.
 *
 * Written out rather than pulled in, for the same reason everything else here is:
 * Derailed is one binary with nothing to install alongside it, and a mail library
 * brings a dependency tree along for a protocol whose sending half is about two
 * hundred lines. It speaks EHLO, STARTTLS, AUTH LOGIN and PLAIN, and one message at
 * a time. It is not a mail server and does not try to be one.
 */

export type MailSecurity = 'tls' | 'starttls' | 'none';

export interface MailAccount {
  host: string;
  port: number;
  security: MailSecurity;
  username?: string | null;
  password?: string | null;
  /** The address the message is from. Also the SMTP envelope sender. */
  from: string;
  /** Shown instead of the bare address in most clients. */
  fromName?: string | null;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * A header value that cannot break out of its header.
 *
 * A newline in a subject line, or in an address, lets whoever supplied it write
 * headers of their own: extra recipients, a different sender, a second body. These
 * values come from settings rather than from the internet, but "only an administrator
 * can set it" is exactly the assumption that stops being true later.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 5322 wants a US-ASCII header; anything else is encoded rather than dropped. */
export function encodeHeaderWord(value: string): string {
  const clean = headerSafe(value);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * The name shown instead of the bare address, safe to put before it.
 *
 * A display name containing `<`, `@`, a comma or a colon has to be quoted, or a mail
 * client reading `From: Derailed Bcc: someone@evil.test <us@example.com>` can take
 * the middle of it for a second address. Encoded words are never quoted: quoting
 * them stops them being decoded and the reader sees the raw `=?UTF-8?B?…`.
 */
export function displayName(value: string): string {
  const encoded = encodeHeaderWord(value);
  if (encoded.startsWith('=?')) return encoded;
  if (!/["()<>@,;:\\.[\]]/.test(encoded)) return encoded;
  return `"${encoded.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * An address is valid enough to hand to a mail server.
 *
 * Deliberately not a full RFC 5322 grammar. This exists to catch the mistakes people
 * make in a settings box, and to refuse anything with a newline or a bracket in it,
 * which is the part that matters.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s<>@,;:"'\\[\]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
    value.trim(),
  );
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** One reply, with its multi-line continuations folded together. */
interface Reply {
  code: number;
  lines: string[];
}

class Session {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiting: ((reply: Reply) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private replies: Reply[] = [];

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.listen();
  }

  private listen(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.absorb(chunk));
    this.socket.on('error', (error: Error) => this.failed?.(error));
  }

  private absorb(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    const pending: string[] = [];
    while (newline >= 0) {
      pending.push(this.buffer.slice(0, newline).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }

    for (const line of pending) {
      this.partial.push(line);
      // "250-EHLO continues" versus "250 EHLO is done": the fourth character says
      // whether more is coming. Reading only the first line loses the capability
      // list, which is how you find out whether STARTTLS is even on offer.
      if (line.length >= 4 && line[3] === '-') continue;
      const code = Number(line.slice(0, 3));
      const reply: Reply = { code, lines: this.partial.map((entry) => entry.slice(4)) };
      this.partial = [];
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(reply);
      } else {
        this.replies.push(reply);
      }
    }
  }

  private partial: string[] = [];

  read(timeoutMs = 30_000): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new MailError('The mail server stopped responding.'));
      }, timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failed = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  /** Sends a command and insists on the reply it was promised. */
  async say(line: string, expect: number[], what: string): Promise<Reply> {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(reply.code)) {
      throw new MailError(
        `The mail server refused ${what}.`,
        `It said: ${reply.code} ${reply.lines.join(' ')}`,
      );
    }
    return reply;
  }

  end(): void {
    try {
      // `end` rather than `destroy`: destroying the socket in the same tick throws
      // the QUIT away before it is flushed, and the server records an aborted
      // connection instead of a polite goodbye. Some of them rate-limit on that.
      this.socket.end('QUIT\r\n');
      this.socket.unref();
    } catch {
      // Already gone. Nothing to do and nothing worth reporting.
    }
  }

  replace(socket: TLSSocket): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket = socket;
    this.buffer = '';
    this.partial = [];
    this.replies = [];
    this.listen();
  }

  get raw(): Socket | TLSSocket {
    return this.socket;
  }
}

/**
 * The body, as one MIME message.
 *
 * Both a plain-text and an HTML part, in that order, which is what
 * `multipart/alternative` means: clients that will not or cannot show HTML have
 * something to read rather than a blank message or a wall of markup.
 */
export function buildMessage(account: MailAccount, mail: Mail, boundary: string): string {
  const from = account.fromName
    ? `${displayName(account.fromName)} <${headerSafe(account.from)}>`
    : headerSafe(account.from);

  const headers = [
    `From: ${from}`,
    `To: ${headerSafe(mail.to)}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${headerSafe(account.from).split('@')[1] ?? 'derailed'}>`,
    'MIME-Version: 1.0',
    // Nobody should reply to a machine, and a bounce should not start a loop.
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(mail.text, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(mail.html, 'utf8').toString('base64')),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Base64 in a mail body is wrapped at 76 characters, and some servers insist. */
function wrap(text: string): string {
  return (text.match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Escapes a line that would otherwise end the message.
 *
 * A lone "." on its own line is how DATA ends. A body containing one is not a
 * theoretical problem: a plain-text list of changes can easily produce it, and the
 * result is a truncated message and the rest of it interpreted as SMTP commands.
 */
export function dotStuff(body: string): string {
  return body.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

export async function sendMail(account: MailAccount, mail: Mail): Promise<void> {
  if (!isEmailAddress(account.from)) {
    throw new MailError(`"${account.from}" is not an address a mail server will accept.`);
  }
  if (!isEmailAddress(mail.to)) {
    throw new MailError(`"${mail.to}" is not an address a mail server will accept.`);
  }
  if (!account.host.trim()) throw new MailError('No mail server has been set.');

  const socket =
    account.security === 'tls'
      ? tlsConnect({ host: account.host, port: account.port, servername: account.host })
      : netConnect({ host: account.host, port: account.port });
  socket.setTimeout(30_000);

  // Not a race between two `once` promises: `events.once` rejects with the raw error
  // whenever the emitter errors, so the connect promise would lose the message and
  // reject first with a bare ECONNREFUSED. One listener each, one settle.
  await new Promise<void>((resolve, reject) => {
    const ready = account.security === 'tls' ? 'secureConnect' : 'connect';
    socket.once(ready, () => resolve());
    socket.once('error', (error: Error) => {
      reject(
        new MailError(`Could not reach ${account.host} on port ${account.port}.`, error.message),
      );
    });
  });

  const session = new Session(socket);
  try {
    const greeting = await session.read();
    if (greeting.code !== 220) {
      throw new MailError('The mail server did not greet us.', greeting.lines.join(' '));
    }

    let capabilities = (await session.say('EHLO derailed', [250], 'the greeting')).lines;

    if (account.security === 'starttls') {
      if (!capabilities.some((line) => line.toUpperCase().startsWith('STARTTLS'))) {
        throw new MailError(
          `${account.host} does not offer STARTTLS on port ${account.port}.`,
          'Try the "TLS" option, which is usually port 465, or port 587 for STARTTLS.',
        );
      }
      await session.say('STARTTLS', [220], 'starting encryption');
      const secure = tlsConnect({ socket: session.raw as Socket, servername: account.host });
      await Promise.race([
        once(secure, 'secureConnect'),
        once(secure, 'error').then(([error]) => {
          throw new MailError('Encryption failed.', (error as Error).message);
        }),
      ]);
      session.replace(secure);
      // Capabilities before and after STARTTLS are allowed to differ, and AUTH is
      // routinely only offered after it, so the list has to be asked for again.
      capabilities = (await session.say('EHLO derailed', [250], 'the greeting')).lines;
    }

    if (account.username && account.password) {
      const offered = (
        capabilities.find((line) => line.toUpperCase().startsWith('AUTH')) ?? ''
      ).toUpperCase();
      const plain = offered.includes('PLAIN');
      if (plain) {
        const token = Buffer.from(`\0${account.username}\0${account.password}`, 'utf8').toString(
          'base64',
        );
        await session.say(`AUTH PLAIN ${token}`, [235], 'the username and password');
      } else {
        await session.say('AUTH LOGIN', [334], 'the username and password');
        await session.say(
          Buffer.from(account.username, 'utf8').toString('base64'),
          [334],
          'the username',
        );
        await session.say(
          Buffer.from(account.password, 'utf8').toString('base64'),
          [235],
          'the password',
        );
      }
    }

    await session.say(`MAIL FROM:<${headerSafe(account.from)}>`, [250], 'the sender');
    await session.say(`RCPT TO:<${headerSafe(mail.to)}>`, [250, 251], 'the recipient');
    await session.say('DATA', [354], 'the message');

    const boundary = `derailed-${crypto.randomUUID()}`;
    session.write(dotStuff(buildMessage(account, mail, boundary)));
    session.write('.');
    const accepted = await session.read(60_000);
    if (accepted.code !== 250) {
      throw new MailError(
        'The mail server would not accept the message.',
        accepted.lines.join(' '),
      );
    }
  } finally {
    session.end();
  }
}
