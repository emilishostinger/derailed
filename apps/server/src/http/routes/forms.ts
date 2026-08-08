import { schemas, topics } from '@derailed/shared';
import { Hono } from 'hono';
import {
  countSubmissions,
  deleteSubmission,
  listSubmissions,
  recordSubmission,
} from '../../db/repo/forms.ts';
import { findService, updateService } from '../../db/repo/services.ts';
import { listUsers } from '../../db/repo/users.ts';
import { publishAll } from '../../events/bus.ts';
import { deliver } from '../../mail/notify.ts';
import { mailAccount } from '../../mail/settings.ts';
import { escapeHtml } from '../../mail/template.ts';
import { emitService } from '../../runtime/present.ts';
import type { AppEnv } from '../auth.ts';
import { RateLimiter } from '../auth.ts';
import { notFound, parseBody } from '../errors.ts';

/**
 * Forms, for the folder-of-HTML crowd.
 *
 * A static site cannot answer a POST, so the proxy catches it and it lands here:
 * a row in a table, a line on the Messages tab, an email if email is set up. No
 * backend, no third-party service, no logo in the confirmation.
 *
 * The public half is deliberately paranoid about what it accepts and deliberately
 * calm about what it rejects: a bot fed to the honeypot is told "thank you", not
 * given a different status code to learn from.
 */

export const publicFormRoutes = new Hono();
export const messageRoutes = new Hono<AppEnv>();

/** Per visitor per app: enough for any human, boring for a script. */
const limiter = new RateLimiter(10, 60_000);

const MAX_FIELDS = 60;
const MAX_KEY = 100;
const MAX_VALUE = 10_000;
const MAX_TOTAL = 64 * 1024;

/** The little page a visitor sees after submitting, when no redirect was asked for. */
function thanksPage(backTo: string | null): string {
  const back = backTo
    ? `<p><a href="${escapeHtml(backTo)}">&larr; Back</a></p>`
    : '<p>You can close this page.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message sent</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;color:#1c1b22;background:#faf9fb;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{max-width:26rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#5b5a66}
  a{color:inherit}
  @media(prefers-color-scheme:dark){body{color:#eceaf2;background:#131218}p{color:#a6a3b3}}
</style></head>
<body><main><h1>Message sent</h1>${back}</main></body></html>`;
}

/**
 * A redirect target a form may name: a path on the same site, nothing else.
 * `//elsewhere.example` is not a path, it is a different site wearing one.
 */
export function safeRedirect(value: string | undefined | null): string | null {
  const target = value?.trim();
  if (!target?.startsWith('/') || target.startsWith('//')) return null;
  return target;
}

publicFormRoutes.post('/form', async (c) => {
  const serviceId = c.req.header('x-derailed-service') ?? '';
  const service = findService(serviceId);
  if (service?.kind !== 'app' || !service.forms) {
    return c.text('This site does not accept messages.', 404);
  }

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  if (!limiter.check(`${serviceId}:${ip ?? 'unknown'}`)) {
    return c.text('That is a lot of messages at once. Try again in a minute.', 429);
  }

  const contentType = c.req.header('content-type') ?? '';
  if (
    !contentType.includes('application/x-www-form-urlencoded') &&
    !contentType.includes('multipart/form-data')
  ) {
    // A JSON POST is an API call aimed at an app that is not one.
    return c.text('This site only accepts form submissions.', 415);
  }

  let raw: Awaited<ReturnType<typeof c.req.raw.formData>>;
  try {
    raw = await c.req.raw.formData();
  } catch {
    return c.text('That did not look like a form submission.', 400);
  }

  const fields: Record<string, string> = {};
  let form = 'form';
  let redirectTo: string | null = null;
  let total = 0;
  let honeypotFed = false;

  for (const [key, value] of raw.entries()) {
    if (typeof value !== 'string') continue; // files are not messages
    if (key === '_derailed' || key === 'form-name') {
      form = value.slice(0, 80) || 'form';
      continue;
    }
    if (key === '_redirect') {
      redirectTo = safeRedirect(value);
      continue;
    }
    // The honeypot: a field people never see and bots always fill.
    if (key === '_gotcha' || key === '_honeypot') {
      if (value.trim() !== '') honeypotFed = true;
      continue;
    }
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    const cleanKey = key.slice(0, MAX_KEY);
    const cleanValue = value.slice(0, MAX_VALUE);
    total += cleanKey.length + cleanValue.length;
    if (total > MAX_TOTAL) break;
    fields[cleanKey] = cleanValue;
  }

  const backTo = safeRedirect(
    (() => {
      try {
        return new URL(c.req.header('referer') ?? '').pathname;
      } catch {
        return null;
      }
    })(),
  );

  // The bot is thanked and nothing is kept. A different answer would teach it
  // which of its attempts got through.
  if (!honeypotFed && Object.keys(fields).length > 0) {
    const submission = recordSubmission(serviceId, form, fields, ip);
    publishAll([topics.service(serviceId), topics.project(service.projectId)], {
      type: 'service.message',
      serviceId,
    });
    void emailOwners(service.name, form, submission.fields).catch(() => undefined);
  }

  if (redirectTo) return c.redirect(redirectTo, 303);
  return c.html(thanksPage(backTo));
});

/** Told to whoever owns the server, quietly skipped when email is not set up. */
async function emailOwners(
  serviceName: string,
  form: string,
  fields: Record<string, string>,
): Promise<void> {
  const account = mailAccount();
  if (!account) return;
  const lines = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const rows = Object.entries(fields)
    .map(
      ([key, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(key)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  for (const user of listUsers()) {
    if (user.role !== 'owner') continue;
    await deliver(account, {
      to: user.email,
      subject: `New message on ${serviceName}`,
      text: `Somebody filled in the "${form}" form on ${serviceName}:\n\n${lines}\n`,
      html: `<p>Somebody filled in the <b>${escapeHtml(form)}</b> form on ${escapeHtml(serviceName)}:</p><table>${rows}</table>`,
    }).catch(() => undefined);
  }
}

/** The Messages tab: what arrived, newest first. */
messageRoutes.get('/:id/messages', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  return c.json({
    enabled: !!service.forms,
    total: countSubmissions(service.id),
    submissions: listSubmissions(service.id, limit, offset),
  });
});

messageRoutes.put('/:id/messages/settings', async (c) => {
  const service = findService(c.req.param('id'));
  if (service?.kind !== 'app') throw notFound('That app');
  const body = await parseBody(c, schemas.formsToggleRequest);
  updateService(service.id, { forms: body.enabled });
  emitService(service.id);
  const { syncRoutes } = await import('../../proxy/sync.ts');
  await syncRoutes();
  return c.json({ enabled: body.enabled });
});

messageRoutes.delete('/:id/messages/:messageId', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  if (!deleteSubmission(service.id, c.req.param('messageId'))) throw notFound('That message');
  return c.json({ ok: true });
});

/** Everything as a spreadsheet-ready file, because that is where lists end up. */
messageRoutes.get('/:id/messages/export', (c) => {
  const service = findService(c.req.param('id'));
  if (!service) throw notFound('That app');
  const submissions = listSubmissions(service.id, 10_000);

  // Columns are the union of every field ever submitted, stable order.
  const columns: string[] = [];
  for (const submission of submissions) {
    for (const key of Object.keys(submission.fields)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  // The leading apostrophe defuses the values spreadsheets would otherwise run
  // as formulas. A message that says "=HYPERLINK(...)" is data, not a program.
  const cell = (value: string) =>
    `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
  const header = ['received', 'form', ...columns].map(cell).join(',');
  const rows = submissions.map((submission) =>
    [
      new Date(submission.createdAt).toISOString(),
      submission.form,
      ...columns.map((column) => submission.fields[column] ?? ''),
    ]
      .map(cell)
      .join(','),
  );
  const csv = [header, ...rows].join('\r\n');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${service.slug}-messages.csv"`);
  return c.body(csv);
});
