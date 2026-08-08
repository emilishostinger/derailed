import { Hono } from 'hono';
import { VERSION } from '../config.ts';
import { auditWrites, listAudit } from './audit.ts';
import { type AppEnv, requireAuth, requireCsrfHeader } from './auth.ts';
import { errorResponse, notFound } from './errors.ts';
import { enforceRole } from './permissions.ts';
import { alertRoutes } from './routes/alerts.ts';
import { appLoginRoutes, publicAppAuthRoutes } from './routes/appauth.ts';
import { appUpdateRoutes } from './routes/appupdates.ts';
import { authRoutes } from './routes/auth.ts';
import { backupRoutes } from './routes/backups.ts';
import { botRoutes, publicChallengeRoutes } from './routes/bots.ts';
import {
  browseRoutes,
  catalogRoutes,
  connectionRoutes,
  linkRoutes,
  singleLinkRoutes,
} from './routes/catalog.ts';
import { dbUpgradeRoutes } from './routes/dbupgrades.ts';
import { deploymentRoutes, serviceDeploymentRoutes } from './routes/deployments.ts';
import { detectRoutes } from './routes/detect.ts';
import { domainRoutes, serviceDomainRoutes } from './routes/domains.ts';
import { messageRoutes, publicFormRoutes } from './routes/forms.ts';
import { importRoutes, projectImportRoutes } from './routes/import.ts';
import { jobRoutes, serviceJobRoutes } from './routes/jobs.ts';
import { mailRoutes } from './routes/mail.ts';
import { peopleRoutes } from './routes/people.ts';
import { projectRoutes } from './routes/projects.ts';
import { projectServiceRoutes, serviceRoutes } from './routes/services.ts';
import {
  publicStatus,
  publicStatusRoutes,
  statusPageEnabled,
  uptimeRoutes,
} from './routes/status.ts';
import { systemRoutes } from './routes/system.ts';
import { projectTemplateRoutes, templateRoutes } from './routes/templates.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { trashRoutes } from './routes/trash.ts';
import { updateRoutes } from './routes/updates.ts';
import { serviceVolumeRoutes, volumeRoutes } from './routes/volumes.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { serveApp } from './static.ts';
import { renderStatusPage } from './statuspage.ts';

/**
 * The dashboard is the control panel for the whole machine, so it should not be
 * embeddable, sniffable, or able to leak where it lives when it links out.
 *
 * `frame-ancestors` rather than `X-Frame-Options` because it is the one browsers still
 * agree on, and it covers the case the old header never did: a frame inside a frame.
 *
 * There is deliberately no `script-src` here. The dashboard sets the theme from an
 * inline script before first paint, so a policy strict enough to be worth having
 * would need a hash kept in step with a file in another package, and a policy loose
 * enough not to break would be `unsafe-inline`, which is no policy at all. The three
 * directives below need no such bookkeeping and cannot be got around: no `<base>` to
 * repoint every relative URL on the page, no form posting anywhere but here, and no
 * plugin content at all.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-frame-options': 'DENY',
  // Severs the link to anything that opened this page, so a window handle to the
  // dashboard is not something another tab can hold on to.
  'cross-origin-opener-policy': 'same-origin',
};

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => errorResponse(c, err));

  app.use('*', async (c, next) => {
    await next();
    if (!c.res) return;
    // A response that came back from `fetch` (the Vite proxy in development) has
    // immutable headers, so rebuild rather than assume we may write to it.
    const headers = new Headers(c.res.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    // Nothing the API answers with should sit in a shared cache: it is all one
    // person's private view of their own server.
    if (new URL(c.req.url).pathname.startsWith('/api/')) headers.set('cache-control', 'no-store');
    c.res = new Response(c.res.body, { status: c.res.status, headers });
  });

  const api = new Hono<AppEnv>();
  // Ahead of the CSRF check, deliberately: a form on somebody's static site is an
  // ordinary browser POST with no special header, and the CSRF token protects the
  // dashboard's session, which these endpoints neither read nor have. The bot
  // challenge is the same story: the solving browser has no dashboard to speak for.
  api.route('/public', publicFormRoutes);
  api.route('/public', publicChallengeRoutes);
  api.route('/public', publicAppAuthRoutes);
  api.use('*', requireCsrfHeader);

  api.get('/health', (c) => c.json({ ok: true, version: VERSION }));
  // Before `requireAuth`, on purpose: a status page nobody can read is not one.
  // It answers 404 until somebody switches it on.
  api.route('/public', publicStatusRoutes);
  // Audited too, and mounted before the session check because signing in has to
  // work without one. Turning a second factor on or off is exactly the kind of change
  // somebody will later want a record of.
  api.use('/auth/*', auditWrites);
  api.route('/auth', authRoutes);

  // Everything below needs a session.
  api.use('*', requireAuth);
  // And every change below is recorded. A middleware rather than a call in each
  // handler, because the handler that forgets is exactly the one somebody will later
  // wish had been recorded.
  api.use('*', auditWrites);
  // And every request below is checked against what this person may do. One place
  // rather than a note on each route, because the route added next Tuesday will not
  // be on a list somebody has to remember to update.
  api.use('*', enforceRole);
  api.route('/people', peopleRoutes);
  api.route('/system', systemRoutes);
  api.route('/mail', mailRoutes);
  api.route('/detect', detectRoutes);
  api.route('/import', importRoutes);
  api.route('/projects', projectImportRoutes);
  api.route('/projects', projectRoutes);
  api.route('/projects', projectServiceRoutes);
  api.route('/projects', projectTemplateRoutes);
  api.route('/services', serviceRoutes);
  api.route('/services', appUpdateRoutes);
  api.route('/services', dbUpgradeRoutes);
  api.route('/services', messageRoutes);
  api.route('/services', botRoutes);
  api.route('/services', appLoginRoutes);
  api.route('/services', serviceDeploymentRoutes);
  api.route('/services', serviceDomainRoutes);
  api.route('/services', connectionRoutes);
  api.route('/services', browseRoutes);
  api.route('/services', linkRoutes);
  api.route('/services', serviceVolumeRoutes);
  api.route('/deployments', deploymentRoutes);
  api.route('/domains', domainRoutes);
  api.route('/links', singleLinkRoutes);
  api.route('/catalog', catalogRoutes);
  api.route('/templates', templateRoutes);
  api.route('/volumes', volumeRoutes);
  api.route('/tokens', tokenRoutes);
  api.route('/updates', updateRoutes);
  api.route('/backups', backupRoutes);
  api.route('/trash', trashRoutes);
  api.route('/alerts', alertRoutes);
  api.route('/webhooks', webhookRoutes);
  api.route('/jobs', jobRoutes);
  api.route('/uptime', uptimeRoutes);
  api.get('/audit', (c) => c.json({ entries: listAudit() }));
  api.route('/services', serviceJobRoutes);

  api.all('*', () => {
    throw notFound('That endpoint');
  });

  app.route('/api', api);

  /**
   * The status page, as a page.
   *
   * Outside `/api` and in front of the dashboard, because the whole point is a URL
   * somebody can be sent. `/api/public/status.json` was the only thing here before,
   * and a customer sent a wall of JSON has not been sent a status page.
   *
   * No session, by design. It answers 404 until somebody switches it on, so a server
   * that never asked for one does not quietly have one.
   */
  app.get('/status', (c) => {
    if (!statusPageEnabled()) return serveApp(c.req.raw);
    return c.html(renderStatusPage(publicStatus()));
  });

  // Anything that isn't /api is the dashboard.
  app.all('*', (c) => serveApp(c.req.raw));

  return app;
}

export type App = ReturnType<typeof createApp>;
