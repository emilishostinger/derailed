import { listEnv, replaceUserEnv } from '../db/repo/env.ts';
import { findService } from '../db/repo/services.ts';
import { mailPassword, mailSettings } from './settings.ts';

/**
 * Letting your apps send email.
 *
 * Every self-hosted app needs to send mail and almost every one of them fails at it:
 * WordPress password resets, Gitea invitations, Vaultwarden verification. It is the
 * number one "I installed it and it half works" complaint in self-hosting, and the
 * reason is always the same: nobody has an SMTP server, and setting one up is a
 * weekend of DNS records.
 *
 * Derailed already solved this for its own notifications, including the honest
 * checks about port 25 and reverse DNS. This hands the same settings to an app as
 * environment variables, which is how every one of these apps expects to be told.
 *
 * The variable names are the hard part: no two apps agree, and somebody who has never
 * heard of SMTP cannot be asked to work out that WordPress wants `SMTP_HOST` while
 * Ghost wants `mail__options__auth__user`. So Derailed sets the common spellings at
 * once, which costs nothing and covers nearly everything.
 */

export interface MailCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  fromName: string;
}

/** What is available to hand out, or null when nothing is set up to send with. */
export function mailCredentials(): MailCredentials | null {
  const settings = mailSettings();

  // Sending straight from this server needs no credentials, and so cannot be handed
  // to an app: the app would have to speak to the recipient's mail server itself,
  // which is exactly the thing it does not know how to do.
  if (settings.delivery === 'server') return null;
  if (!settings.host.trim() || !settings.from.trim()) return null;

  const password = mailPassword();
  if (!settings.username.trim() || !password) return null;

  return {
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    username: settings.username,
    password,
    from: settings.from,
    fromName: settings.fromName || 'Derailed',
  };
}

/**
 * The spellings an app might be looking for.
 *
 * Deliberately several at once. Setting six variables an app ignores costs nothing;
 * setting the wrong one and leaving somebody with a password reset that silently
 * never arrives costs them an afternoon.
 */
export function mailEnvFor(credentials: MailCredentials): Record<string, string> {
  const port = String(credentials.port);
  const secure = credentials.secure ? 'true' : 'false';

  return {
    // The spelling most things use.
    SMTP_HOST: credentials.host,
    SMTP_PORT: port,
    SMTP_USER: credentials.username,
    SMTP_PASSWORD: credentials.password,
    SMTP_SECURE: secure,
    SMTP_FROM: credentials.from,

    // WordPress plugins, Gitea, and a long tail of PHP.
    MAIL_HOST: credentials.host,
    MAIL_PORT: port,
    MAIL_USERNAME: credentials.username,
    MAIL_PASSWORD: credentials.password,
    MAIL_ENCRYPTION: credentials.secure ? 'tls' : 'none',
    MAIL_FROM_ADDRESS: credentials.from,
    MAIL_FROM_NAME: credentials.fromName,

    // Node applications that read a single URL. The password is percent-encoded
    // because a mail password containing an `@` or a `:` would otherwise produce a
    // URL that parses into something else entirely.
    SMTP_URL: `smtp${credentials.secure ? 's' : ''}://${encodeURIComponent(
      credentials.username,
    )}:${encodeURIComponent(credentials.password)}@${credentials.host}:${port}`,
  };
}

/** Names Derailed sets, so turning this off can take exactly those away again. */
export const MAIL_ENV_KEYS = Object.keys(
  mailEnvFor({
    host: '',
    port: 0,
    secure: false,
    username: '',
    password: '',
    from: '',
    fromName: '',
  }),
);

export function appCanSendMail(serviceId: string): boolean {
  return listEnv(serviceId).some((entry) => entry.key === 'SMTP_HOST');
}

export class AppMailError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'AppMailError';
    this.hint = hint;
  }
}

/**
 * Turns it on or off for one app.
 *
 * Written as ordinary variables rather than anything special, so they are visible on
 * the Variables tab, can be overridden there, and behave exactly like everything else
 * the app is given. Nothing here is magic and nothing is hidden.
 */
export function setAppMail(serviceId: string, enabled: boolean): void {
  const service = findService(serviceId);
  if (!service) throw new AppMailError('That app no longer exists.');

  const existing = listEnv(serviceId).filter((entry) => entry.source === 'user');

  if (!enabled) {
    replaceUserEnv(
      serviceId,
      existing
        .filter((entry) => !MAIL_ENV_KEYS.includes(entry.key))
        .map((entry) => ({ key: entry.key, value: entry.value })),
    );
    return;
  }

  const credentials = mailCredentials();
  if (!credentials) {
    throw new AppMailError(
      'Derailed has nothing to send email with yet.',
      'Set up a mail provider under Settings first. "From this server" cannot be shared with an app, because the app would have to talk to each recipient itself.',
    );
  }

  const mail = mailEnvFor(credentials);
  // Anything already set by hand wins. Somebody who typed their own SMTP_HOST meant
  // it, and quietly replacing it would be the worst kind of helpful.
  const kept = existing.filter((entry) => !MAIL_ENV_KEYS.includes(entry.key));
  const byHand = new Set(existing.map((entry) => entry.key));

  replaceUserEnv(serviceId, [
    ...kept.map((entry) => ({ key: entry.key, value: entry.value })),
    ...Object.entries(mail)
      .filter(([key]) => !byHand.has(key) || MAIL_ENV_KEYS.includes(key))
      .map(([key, value]) => ({ key, value })),
  ]);
}
