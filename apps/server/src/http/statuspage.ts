import type { PublicStatus } from './routes/status.ts';

/**
 * The status page, as a page.
 *
 * There was only ever `/api/public/status.json`, which is a fine thing to have and is
 * not what anybody means by "a status page you can share". Sending a customer a URL
 * that answers with a wall of JSON is worse than sending nothing.
 *
 * Rendered on the server as one self-contained document: no framework, no build step,
 * no request to anywhere. Partly because it is thirty lines of HTML and does not need
 * one, and partly because this is the page people see when everything else is on fire.
 * It must not depend on the dashboard's assets loading, on a CDN being reachable, or
 * on JavaScript running at all.
 *
 * It says less than it knows, deliberately. No project names, no service names, no
 * failure reasons, no version, no machine. A failure message can name an upstream, a
 * port or a container, and none of that is a visitor's business.
 */

/** Escaped for HTML. The only untrusted value here is a hostname, but it is still text. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bar(percent: number): string {
  // Three states rather than a gradient. "Was it up" is the question, and a spectrum
  // invites reading a shade of green as a number, which it is not.
  const state = percent >= 99.5 ? 'ok' : percent >= 90 ? 'warn' : 'bad';
  return `<i class="${state}" title="${percent.toFixed(1)}% up"></i>`;
}

function site(entry: PublicStatus['sites'][number]): string {
  const label = entry.up === null ? 'Not checked yet' : entry.up ? 'Up' : 'Down';
  const state = entry.up === null ? 'unknown' : entry.up ? 'ok' : 'bad';
  const overall =
    entry.uptimePercent === null
      ? ''
      : `<span class="pct">${entry.uptimePercent.toFixed(2)}%</span>`;

  return `
    <section class="site">
      <header>
        <span class="dot ${state}"></span>
        <h2>${escapeHtml(entry.name)}</h2>
        <span class="state ${state}">${label}</span>
      </header>
      <div class="days">${entry.days.map((day) => bar(day.uptimePercent)).join('')}</div>
      <footer><span>90 days ago</span>${overall}<span>today</span></footer>
    </section>`;
}

export function renderStatusPage(status: PublicStatus): string {
  // Deliberately not `allUp`, which counts "never checked" as fine. On a page whose
  // entire job is to be believed, announcing that all systems are normal when nothing
  // has been asked yet is the one sentence that must never appear.
  const down = status.sites.filter((entry) => entry.up === false).length;
  const unknown = status.sites.filter((entry) => entry.up === null).length;
  const up = status.sites.filter((entry) => entry.up === true).length;

  const [headline, tone] =
    status.sites.length === 0
      ? ['Nothing is being watched yet', 'unknown']
      : down > 0
        ? [down === 1 ? 'One site is down' : `${down} sites are down`, 'bad']
        : up === 0
          ? ['Not checked yet', 'unknown']
          : unknown > 0
            ? ['Everything checked is up', 'ok']
            : ['All systems normal', 'ok'];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(status.title)}</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0e0e10; --card: #161619; --line: #26262b;
    --ink: #ededf0; --muted: #a0a0aa; --faint: #6b6b76;
    --ok: #3ecf8e; --warn: #e8b04b; --bad: #f2555a; --unknown: #6b6b76;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fbfbfc; --card: #fff; --line: #e6e6ea;
      --ink: #17171a; --muted: #5c5c66; --faint: #8b8b96;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.25rem; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; font-weight: 600; }
  .overall { display: flex; align-items: center; gap: .6rem; margin-bottom: 2rem; }
  .checked { color: var(--faint); font-size: .8rem; margin: 0; }
  .site { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: .75rem; }
  .site header { display: flex; align-items: center; gap: .55rem; margin-bottom: .75rem; }
  .site h2 { font-size: .95rem; font-weight: 500; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { font-size: .8rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok, .state.ok { background: var(--ok); }
  .state.ok { background: none; color: var(--ok); }
  .dot.bad { background: var(--bad); }
  .state.bad { color: var(--bad); }
  .dot.unknown { background: var(--unknown); }
  .state.unknown { color: var(--faint); }
  .days { display: flex; gap: 2px; height: 30px; align-items: stretch; }
  .days i { flex: 1; min-width: 2px; border-radius: 2px; background: var(--ok); }
  .days i.warn { background: var(--warn); }
  .days i.bad { background: var(--bad); }
  .site footer { display: flex; justify-content: space-between; align-items: baseline; margin-top: .5rem; font-size: .75rem; color: var(--faint); }
  .pct { color: var(--muted); }
  .empty { color: var(--muted); }
  .by { margin-top: 2.5rem; font-size: .75rem; color: var(--faint); text-align: center; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(status.title)}</h1>
  <div class="overall">
    <span class="dot ${tone}"></span>
    <strong>${headline}</strong>
  </div>

  ${
    status.sites.length === 0
      ? '<p class="empty">No addresses are being checked yet.</p>'
      : status.sites.map(site).join('')
  }

  <p class="checked">Checked every five minutes. Last checked ${new Date(status.at).toUTCString()}.</p>
  <p class="by">Running on Derailed</p>
</main>
</body>
</html>`;
}
