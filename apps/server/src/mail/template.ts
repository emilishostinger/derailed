import type { UpdateItem } from '../system/updates.ts';

/**
 * The update notice, as an email.
 *
 * Mail clients are not browsers. Half of them strip `<style>`, most ignore flexbox
 * and grid, Outlook renders through Word, and none of them will fetch an image from
 * a server that is probably not on the public internet. So: tables, inline styles,
 * no images, no web fonts, and a plain-text version that says the same thing for
 * anyone whose client refuses HTML outright.
 *
 * `prefers-color-scheme` is in a `<style>` block because there is nowhere else to put
 * a media query. Clients that drop the block get the light version, which is why the
 * inline styles are the light ones rather than the dark.
 */

const BRAND = '#7236e3';
const INK = '#16181d';
const MUTED = '#5b6270';
const LINE = '#e2e5ee';
const CANVAS = '#f4f6fa';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface UpdateNotice {
  items: UpdateItem[];
  rebootRequired: boolean;
  /** Where to go and do something about it. Omitted when there is no domain set. */
  dashboardUrl: string | null;
  hostname: string;
}

function kindLabel(kind: UpdateItem['kind']): string {
  return kind === 'system' ? 'System' : kind === 'image' ? 'App image' : 'Derailed';
}

function versionLine(item: UpdateItem): string {
  if (item.current && item.available) return `${item.current} to ${item.available}`;
  if (item.available) return item.available;
  return '';
}

export function subjectFor(notice: UpdateNotice): string {
  const security = notice.items.filter((item) => item.security).length;
  const count = notice.items.length;
  const what = count === 1 ? '1 update' : `${count} updates`;
  // The word people scan for goes at the front, and the machine's name is in there
  // because anyone running two servers gets two of these.
  if (security > 0) {
    return `${notice.hostname}: ${security} security update${security === 1 ? '' : 's'} waiting`;
  }
  return `${notice.hostname}: ${what} waiting`;
}

export function textFor(notice: UpdateNotice): string {
  // `null` for the parts that may not apply, never `''`: filtering on empty strings
  // also throws away the blank lines that separate the paragraphs, and the first
  // version of this arrived as one unreadable block.
  const blocks: (string | null)[] = [
    subjectFor(notice),
    notice.items
      .map((item) => {
        const version = versionLine(item);
        return [
          `* ${item.name}${item.security ? '  (security)' : ''}`,
          `  ${kindLabel(item.kind)}${version ? `, ${version}` : ''}`,
          `  ${item.detail}`,
        ].join('\n');
      })
      .join('\n\n'),
    notice.rebootRequired ? 'This server needs a restart to finish applying updates.' : null,
    notice.dashboardUrl
      ? `Apply them: ${notice.dashboardUrl}/updates`
      : 'Apply them from the Updates page in your dashboard.',
    `Sent by Derailed, running on ${notice.hostname}.\nTo stop these, turn off update emails in Settings.`,
  ];
  return blocks.filter((block) => block !== null).join('\n\n');
}

function row(item: UpdateItem): string {
  const version = versionLine(item);
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid ${LINE};" class="d-line">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font:600 15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};" class="d-ink">
              ${escapeHtml(item.name)}
            </td>
            <td align="right" style="font:400 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};white-space:nowrap;" class="d-muted">
              ${
                item.security
                  ? `<span class="d-danger" style="display:inline-block;padding:2px 8px;border-radius:999px;background:#fdecec;color:#b42318;font-weight:600;">Security</span>`
                  : // Saying "Derailed" beside a row already called Derailed is one
                    // word doing no work at all.
                    escapeHtml(kindLabel(item.kind) === item.name ? '' : kindLabel(item.kind))
              }
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:4px;font:400 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};" class="d-muted">
              ${escapeHtml(item.detail)}${
                version
                  ? ` <span style="color:${INK};" class="d-ink">${escapeHtml(version)}</span>`
                  : ''
              }
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

export function htmlFor(notice: UpdateNotice): string {
  const security = notice.items.filter((item) => item.security).length;
  const lead =
    security > 0
      ? `${security} of these ${security === 1 ? 'is a security update' : 'are security updates'}.`
      : 'Nothing here is urgent, but it is waiting.';

  const button = notice.dashboardUrl
    ? `
      <tr>
        <td style="padding-top:26px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius:8px;background:${BRAND};">
                <a href="${escapeHtml(notice.dashboardUrl)}/updates"
                   style="display:inline-block;padding:11px 20px;font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;">
                  Review them
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : `
      <tr>
        <td style="padding-top:22px;font:400 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};" class="d-muted">
          Open the Updates page in your dashboard to apply them.
        </td>
      </tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subjectFor(notice))}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .d-canvas { background: #0b0c11 !important; }
    .d-card   { background: #121319 !important; border-color: #262a36 !important; }
    .d-ink    { color: #f4f6fa !important; }
    .d-muted  { color: #9aa3b5 !important; }
    .d-line   { border-color: #262a36 !important; }
    .d-brand  { color: #a78bfa !important; }
    .d-danger { background: #2a1416 !important; color: #f0736b !important; }
    .d-warn   { background: #241d0c !important; color: #e0b64a !important; }
  }
  @media (max-width: 620px) {
    .d-pad { padding: 24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CANVAS};" class="d-canvas">
  <!-- Shown in the inbox list under the subject, and nowhere else. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(notice.items.map((item) => item.name).join(', '))}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS};" class="d-canvas">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

          <tr>
            <td style="padding-bottom:16px;font:700 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND};letter-spacing:-0.01em;" class="d-brand">
              Derailed
            </td>
          </tr>

          <tr>
            <td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;" class="d-card">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td class="d-pad" style="padding:30px;">

                    <p style="margin:0;font:600 20px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};" class="d-ink">
                      ${notice.items.length === 1 ? 'One update is' : `${notice.items.length} updates are`} waiting on ${escapeHtml(notice.hostname)}
                    </p>
                    <p style="margin:8px 0 0;font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};" class="d-muted">
                      ${escapeHtml(lead)}
                    </p>

                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;">
                      ${notice.items.map(row).join('')}
                    </table>

                    ${
                      notice.rebootRequired
                        ? `<p class="d-warn" style="margin:18px 0 0;padding:12px 14px;border-radius:8px;background:#fff8e6;font:400 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#7a5b00;">
                             This server needs a restart to finish applying updates it already has.
                           </p>`
                        : ''
                    }

                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      ${button}
                    </table>

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 4px 0;font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};" class="d-muted">
              Sent by Derailed on ${escapeHtml(notice.hostname)}. Turn these off under Settings if you would rather check yourself.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
