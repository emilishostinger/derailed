import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { notifyAboutUpdates, sendTestEmail } from '../../mail/notify.ts';
import { mailSettings, saveMailSettings } from '../../mail/settings.ts';
import { isEmailAddress, MailError } from '../../mail/smtp.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, parseBody } from '../errors.ts';

export const mailRoutes = new Hono<AppEnv>();

mailRoutes.get('/', (c) => c.json({ mail: mailSettings() }));

mailRoutes.patch('/', async (c) => {
  const patch = await parseBody(c, schemas.patchMailRequest);

  // Checked here rather than in the schema, so the message can say which field and
  // why. An address that a mail server will reject is worth catching at the point
  // somebody typed it, not at three in the morning when the notice fails to send.
  for (const [field, value] of [
    ['From address', patch.from],
    ['Send notices to', patch.notifyTo],
  ] as const) {
    if (value && !isEmailAddress(value)) {
      throw badRequest(`${field} does not look like an email address.`, `Got "${value}".`);
    }
  }

  const saved = saveMailSettings(patch);

  if (saved.notifyUpdates && !saved.host.trim()) {
    throw badRequest(
      'Update emails need a mail server to send through.',
      'Fill in the server, port and from address first.',
    );
  }

  return c.json({ mail: saved });
});

/**
 * Sends one, now, and says what happened.
 *
 * A settings page with a Save button and no way to find out whether it works is a
 * settings page people fill in wrongly and never discover. Mail is particularly bad
 * for this: the failure is always somewhere else and always silent.
 */
mailRoutes.post('/test', async (c) => {
  const { to } = await parseBody(c, schemas.testMailRequest);
  const settings = mailSettings();
  const recipient = (to || settings.notifyTo || settings.from).trim();

  if (!isEmailAddress(recipient)) {
    throw badRequest(
      'There is nowhere to send it.',
      'Fill in "Send notices to", or the from address.',
    );
  }

  try {
    await sendTestEmail(recipient);
  } catch (error) {
    if (error instanceof MailError) throw badRequest(error.message, error.hint);
    throw badRequest('Could not send the email.', (error as Error).message);
  }

  return c.json({ ok: true, to: recipient });
});

/** Runs the real check, on demand, so "would it email me?" has an answer. */
mailRoutes.post('/notify', async (c) => {
  try {
    return c.json({ result: await notifyAboutUpdates({ force: true }) });
  } catch (error) {
    if (error instanceof MailError) throw badRequest(error.message, error.hint);
    throw badRequest('Could not send the email.', (error as Error).message);
  }
});
