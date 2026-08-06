import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { digestOf } from '../src/mail/notify.ts';
import { mailAccount, mailPassword, mailSettings, saveMailSettings } from '../src/mail/settings.ts';
import {
  buildMessage,
  displayName,
  dotStuff,
  encodeHeaderWord,
  headerSafe,
  isEmailAddress,
  MailError,
  sendMail,
} from '../src/mail/smtp.ts';
import { escapeHtml, htmlFor, subjectFor, textFor } from '../src/mail/template.ts';
import type { UpdateItem } from '../src/system/updates.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Sending mail, against a mail server that is really listening.
 *
 * A hand-written SMTP client is exactly the sort of thing that works against one
 * server and falls over on the next, so most of this drives a real socket through a
 * real conversation rather than asserting on strings. The fake server records what it
 * was told, which is the only way to catch a message that is well-formed but says the
 * wrong thing.
 */

interface Fake {
  port: number;
  said: string[];
  body: string;
  close: () => Promise<void>;
}

/** A minimal SMTP server. `script` maps a command to the reply it should get. */
async function fakeServer(
  script: (command: string, state: { data: boolean }) => string | null = () => null,
): Promise<Fake> {
  const said: string[] = [];
  let body = '';

  const server: Server = createServer((socket: Socket) => {
    const state = { data: false };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.write('220 fake.test ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\r\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        newline = buffer.indexOf('\r\n');

        if (state.data) {
          if (line === '.') {
            state.data = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            body += `${line}\r\n`;
          }
          continue;
        }

        said.push(line);
        const scripted = script(line, state);
        if (scripted !== null) {
          socket.write(`${scripted}\r\n`);
          continue;
        }

        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 Ok\r\n');
        else if (verb === 'DATA') {
          state.data = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'AUTH') socket.write('235 2.7.0 Authenticated\r\n');
        else if (verb === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 Ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    said,
    get body() {
      return body;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Waits for something the server has not been told yet. */
async function until(ready: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) await Bun.sleep(10);
}

let running: Fake | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

const account = (port: number, over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  security: 'none' as const,
  from: 'derailed@example.com',
  fromName: 'Derailed',
  ...over,
});

const mail = {
  to: 'someone@example.com',
  subject: 'Two updates waiting',
  text: 'plain version',
  html: '<p>html version</p>',
};

describe('sending a message', () => {
  test('walks the whole conversation and hands over the body', async () => {
    running = await fakeServer();
    await sendMail(account(running.port), mail);

    expect(running.said.map((line) => line.split(' ')[0]!.toUpperCase())).toEqual([
      'EHLO',
      'MAIL',
      'RCPT',
      'DATA',
    ]);
    expect(running.said).toContain('MAIL FROM:<derailed@example.com>');
    expect(running.said).toContain('RCPT TO:<someone@example.com>');

    // QUIT goes out after the message is accepted, so sendMail does not wait for it.
    // It still has to arrive: a connection dropped mid-session is what some servers
    // count against you.
    await until(() => running!.said.includes('QUIT'));
    expect(running.said).toContain('QUIT');
  });

  test('both a plain-text and an HTML part arrive, and both are readable', async () => {
    running = await fakeServer();
    await sendMail(account(running.port), mail);

    expect(running.body).toContain('multipart/alternative');
    // Base64, so the assertion has to decode rather than search for the words.
    const parts = running.body.split(/--derailed-[0-9a-f-]+/);
    const decoded = parts
      .filter((part) => part.includes('Content-Transfer-Encoding: base64'))
      .map((part) => {
        const payload = part.split('\r\n\r\n').slice(1).join('').replace(/\s/g, '');
        return Buffer.from(payload, 'base64').toString('utf8');
      });
    expect(decoded).toContain('plain version');
    expect(decoded).toContain('<p>html version</p>');
  });

  test('authenticates when there is a username, and does not when there is not', async () => {
    running = await fakeServer();
    await sendMail(account(running.port, { username: 'bob', password: 'hunter2' }), mail);
    const auth = running.said.find((line) => line.startsWith('AUTH'));
    expect(auth).toBeTruthy();
    // AUTH PLAIN is offered first, so it is what should be used.
    expect(auth).toStartWith('AUTH PLAIN ');
    expect(Buffer.from(auth!.slice('AUTH PLAIN '.length), 'base64').toString('utf8')).toBe(
      '\0bob\0hunter2',
    );

    await running.close();
    running = await fakeServer();
    await sendMail(account(running.port), mail);
    expect(running.said.some((line) => line.startsWith('AUTH'))).toBe(false);
  });

  test('falls back to AUTH LOGIN when PLAIN is not on offer', async () => {
    const user = Buffer.from('bob', 'utf8').toString('base64');
    const pass = Buffer.from('hunter2', 'utf8').toString('base64');
    running = await fakeServer((command) => {
      if (command.toUpperCase().startsWith('EHLO')) {
        return '250-fake.test\r\n250-AUTH LOGIN\r\n250 SIZE';
      }
      if (command.toUpperCase() === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
      if (command === user) return '334 UGFzc3dvcmQ6';
      if (command === pass) return '235 2.7.0 Authenticated';
      return null;
    });
    await sendMail(account(running.port, { username: 'bob', password: 'hunter2' }), mail);
    expect(running.said).toContain('AUTH LOGIN');
    expect(running.said).toContain(Buffer.from('bob', 'utf8').toString('base64'));
    expect(running.said).toContain(Buffer.from('hunter2', 'utf8').toString('base64'));
  });

  test('a refusal is reported with what the server actually said', async () => {
    running = await fakeServer((command) =>
      command.toUpperCase().startsWith('RCPT') ? '550 5.1.1 No such user here' : null,
    );
    const failure = await sendMail(account(running.port), mail).catch((error) => error);
    expect(failure).toBeInstanceOf(MailError);
    expect((failure as MailError).message).toContain('recipient');
    expect((failure as MailError).hint).toContain('550');
  });

  test('a bad password is reported as such rather than as a mystery', async () => {
    running = await fakeServer((command) =>
      command.toUpperCase().startsWith('AUTH')
        ? '535 5.7.8 Authentication credentials invalid'
        : null,
    );
    const failure = await sendMail(
      account(running.port, { username: 'bob', password: 'wrong' }),
      mail,
    ).catch((error) => error);
    expect((failure as MailError).message).toContain('username and password');
    expect((failure as MailError).hint).toContain('535');
  });

  test('asking for STARTTLS on a server that does not offer it says so', async () => {
    running = await fakeServer();
    const failure = await sendMail(account(running.port, { security: 'starttls' }), mail).catch(
      (error) => error,
    );
    expect((failure as MailError).message).toContain('does not offer STARTTLS');
    expect((failure as MailError).hint).toContain('465');
  });

  test('a server that is not there fails quickly and by name', async () => {
    // Port 1 is reserved and nothing listens on it.
    const failure = await sendMail(account(1), mail).catch((error) => error);
    expect(failure).toBeInstanceOf(MailError);
    expect((failure as MailError).message).toContain('Could not reach');
  });

  test('nothing is sent to an address a server would reject', async () => {
    running = await fakeServer();
    for (const to of [
      'not an address',
      'a@b',
      'a b@example.com',
      '',
      'a@example.com\nbcc: c@d.e',
    ]) {
      const failure = await sendMail(account(running.port), { ...mail, to }).catch((e) => e);
      expect({ to, error: failure instanceof MailError }).toEqual({ to, error: true });
    }
    expect(running.said).toEqual([]);
  });
});

describe('the message itself', () => {
  test('a newline in a header cannot become a header of its own', () => {
    const built = buildMessage(
      { ...account(1), fromName: 'Derailed\r\nBcc: attacker@evil.test' },
      { ...mail, subject: 'Hello\r\nBcc: attacker@evil.test' },
      'b',
    );
    const headers = built.split('\r\n\r\n')[0]!.split('\r\n');
    // The test is that no new header line appeared, not that the word is absent:
    // "Bcc:" as literal text inside a value is inert.
    expect(headers.some((line) => line.toLowerCase().startsWith('bcc:'))).toBe(false);
    expect(headers.filter((line) => line.startsWith('Subject:'))).toHaveLength(1);
    expect(headers.filter((line) => line.startsWith('From:'))).toHaveLength(1);
    // And a display name holding an address is quoted, so no client can read the
    // middle of it as a second recipient.
    const from = headers.find((line) => line.startsWith('From:'))!;
    expect(from).toBe('From: "Derailed Bcc: attacker@evil.test" <derailed@example.com>');
  });

  test('a subject with accents in it survives as something readable', () => {
    expect(encodeHeaderWord('Mise à jour')).toStartWith('=?UTF-8?B?');
    expect(
      Buffer.from(encodeHeaderWord('Mise à jour').slice(10, -2), 'base64').toString('utf8'),
    ).toBe('Mise à jour');
    expect(encodeHeaderWord('Plain ASCII')).toBe('Plain ASCII');
  });

  test('headerSafe flattens every kind of line break', () => {
    expect(headerSafe('a\r\nb')).toBe('a b');
    expect(headerSafe('a\nb')).toBe('a b');
    expect(headerSafe('a\rb')).toBe('a b');
    expect(headerSafe('  padded  ')).toBe('padded');
  });

  test('a line that is only a dot cannot end the message early', () => {
    // Without this, everything after it is read by the server as SMTP commands.
    expect(dotStuff('one\r\n.\r\ntwo')).toBe('one\r\n..\r\ntwo');
    expect(dotStuff('.leading')).toBe('..leading');
    expect(dotStuff('nothing to do')).toBe('nothing to do');
  });

  test('the from name is only used when there is one', () => {
    expect(buildMessage(account(1), mail, 'b')).toContain('From: Derailed <derailed@example.com>');
    expect(buildMessage({ ...account(1), fromName: null }, mail, 'b')).toContain(
      'From: derailed@example.com',
    );
  });

  test('a display name is quoted only when it needs to be', () => {
    expect(displayName('Derailed')).toBe('Derailed');
    expect(displayName('Derailed Updates')).toBe('Derailed Updates');
    expect(displayName('Ops, Derailed')).toBe('"Ops, Derailed"');
    expect(displayName('a"b\\c')).toBe('"a\\"b\\\\c"');
    // An encoded word must stay bare or it is shown raw rather than decoded.
    expect(displayName('Mise à jour')).toStartWith('=?UTF-8?B?');
  });

  test('it is marked as automatic, so nothing tries to hold a conversation with it', () => {
    expect(buildMessage(account(1), mail, 'b')).toContain('Auto-Submitted: auto-generated');
  });
});

describe('what counts as an address', () => {
  test('ordinary ones pass', () => {
    for (const value of [
      'a@b.co',
      'first.last@example.com',
      'first+tag@example.co.uk',
      'DERAILED@EXAMPLE.COM',
      '  padded@example.com  ',
    ]) {
      expect({ value, ok: isEmailAddress(value) }).toEqual({ value, ok: true });
    }
  });

  test('the ones that would break a header do not', () => {
    for (const value of [
      '',
      'nope',
      'a@b',
      'a@.com',
      'a@b.',
      'a b@example.com',
      'a@example.com, b@example.com',
      'a@example.com\r\nBcc: c@d.ee',
      '<a@example.com>',
      'a@exam ple.com',
    ]) {
      expect({ value, ok: isEmailAddress(value) }).toEqual({ value, ok: false });
    }
  });
});

const item = (over: Partial<UpdateItem> = {}): UpdateItem => ({
  id: 'openssl',
  kind: 'system',
  name: 'openssl',
  detail: 'A security fix is available.',
  actionable: true,
  current: '3.0.1',
  available: '3.0.2',
  ...over,
});

describe('the notice', () => {
  const notice = (items: UpdateItem[], reboot = false) => ({
    items,
    rebootRequired: reboot,
    dashboardUrl: 'https://panel.example.com',
    hostname: 'panel.example.com',
  });

  test('the subject leads with security when anything is a security update', () => {
    expect(
      subjectFor(notice([item({ security: true }), item({ id: 'curl', security: false })])),
    ).toBe('panel.example.com: 1 security update waiting');
    expect(subjectFor(notice([item({ security: false })]))).toBe(
      'panel.example.com: 1 update waiting',
    );
    expect(subjectFor(notice([item(), item({ id: 'curl' })]))).toBe(
      'panel.example.com: 2 updates waiting',
    );
  });

  test('the plain-text version is laid out, not run together', () => {
    // Every part of it separated by a blank line. An earlier version filtered empty
    // strings out of the list it was built from and arrived as one solid block.
    const text = textFor(notice([item({ id: 'a' }), item({ id: 'b', name: 'curl' })]));
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(4);
    expect(text).toMatch(/openssl[\s\S]*\n\n\* curl/);
  });

  test('the plain-text version says everything the HTML one does', () => {
    const text = textFor(notice([item({ security: true })], true));
    expect(text).toContain('openssl');
    expect(text).toContain('3.0.1 to 3.0.2');
    expect(text).toContain('security');
    expect(text).toContain('restart');
    expect(text).toContain('https://panel.example.com/updates');
  });

  test('the HTML version has no external anything in it', () => {
    const html = htmlFor(notice([item()]));
    // A mail client will not fetch from a server that is probably not public, and a
    // remote image is also a read receipt nobody asked for.
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!panel\.example\.com)/);
  });

  test('a package name cannot inject markup into the email', () => {
    const html = htmlFor(notice([item({ name: '<script>alert(1)</script>', detail: '"><b>x' })]));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  test('without a dashboard domain it points at the page rather than a broken link', () => {
    const html = htmlFor({ ...notice([item()]), dashboardUrl: null });
    expect(html).toContain('Updates page');
    expect(html).not.toContain('href="null');
  });

  test('it offers a way to stop receiving it', () => {
    expect(htmlFor(notice([item()]))).toContain('Settings');
    expect(textFor(notice([item()]))).toContain('turn off update emails');
  });
});

describe('deciding whether to send at all', () => {
  test('the same set of updates makes the same fingerprint, in any order', () => {
    const a = [item({ id: 'a' }), item({ id: 'b' })];
    expect(digestOf(a)).toBe(digestOf([...a].reverse()));
  });

  test('a new version of the same package is a different fingerprint', () => {
    expect(digestOf([item({ available: '3.0.2' })])).not.toBe(
      digestOf([item({ available: '3.0.3' })]),
    );
  });

  test('one more update is a different fingerprint', () => {
    expect(digestOf([item()])).not.toBe(digestOf([item(), item({ id: 'curl' })]));
  });

  test('a package becoming a security update is worth telling you about again', () => {
    expect(digestOf([item({ security: false })])).not.toBe(digestOf([item({ security: true })]));
  });

  test('nothing pending has a stable fingerprint of its own', () => {
    expect(digestOf([])).toBe(digestOf([]));
  });
});

describe('the stored mail settings', () => {
  // A real database and a real key, because the whole point of these is what the
  // settings table does with an empty value versus a missing one, and whether the
  // password survives a round trip through the encryption.
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'derailed-mail-'));
    initDb(join(dir, 'test.db'));
    loadSecretKey(join(dir, 'secret.key'));
  });

  /** Each of these starts from nothing, rather than from the last one's leftovers. */
  const blank = () => {
    saveMailSettings({
      host: '',
      port: 587,
      security: 'starttls',
      username: '',
      password: '',
      from: '',
      fromName: 'Derailed',
      notifyUpdates: false,
      notifyTo: '',
      securityOnly: false,
    });
  };

  test('the password is stored, never handed back, and can be cleared', () => {
    blank();
    expect(mailSettings().hasPassword).toBe(false);

    saveMailSettings({ password: 'hunter2' });
    expect(mailSettings().hasPassword).toBe(true);
    expect(mailPassword()).toBe('hunter2');
    // The settings the dashboard receives have no password field at all.
    expect(Object.keys(mailSettings())).not.toContain('password');

    // Clearing it writes an empty value rather than deleting the row, and an
    // empty string is not null: this is what made it keep saying one was saved.
    saveMailSettings({ password: '' });
    expect(mailSettings().hasPassword).toBe(false);
    expect(mailPassword()).toBeNull();
  });

  test('leaving the password out entirely does not disturb the stored one', () => {
    blank();
    saveMailSettings({ password: 'hunter2' });
    saveMailSettings({ host: 'smtp.example.com' });
    expect(mailPassword()).toBe('hunter2');
    expect(mailSettings().host).toBe('smtp.example.com');
  });

  test('the port follows the encryption when it has never been set', () => {
    blank();
    expect(mailSettings().port).toBe(587);
    saveMailSettings({ security: 'tls', port: 465 });
    expect(mailSettings().port).toBe(465);
  });

  test('there is no account to send with until there is a server and a from address', () => {
    blank();
    expect(mailAccount()).toBeNull();
    saveMailSettings({ host: 'smtp.example.com' });
    expect(mailAccount()).toBeNull();
    saveMailSettings({ from: 'not an address' });
    expect(mailAccount()).toBeNull();
    saveMailSettings({ from: 'derailed@example.com' });
    expect(mailAccount()?.host).toBe('smtp.example.com');
  });
});
