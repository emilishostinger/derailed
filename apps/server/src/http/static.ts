import { isDev } from '../config.ts';
import { assets } from '../generated/assets.ts';

/** Where the dashboard actually lives in dev. See the port note in `config.ts`. */
export const VITE_ORIGIN = process.env.DERAILED_VITE_ORIGIN ?? 'http://localhost:1337';

export const hasEmbeddedApp = Object.keys(assets).length > 0;

/**
 * Serves the React app.
 *
 * Production: files are embedded in the binary (`with { type: 'file' }`), so this is
 * just a map lookup.
 *
 * Development: hand off to Vite, which is the one listening on the dashboard's port.
 * This path only runs when somebody opens the API port directly, and it is a courtesy
 * redirect rather than a working dev server: HMR's websocket does not survive the
 * hop, so it bounces the browser to Vite instead of proxying the page.
 */
export async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);

  if (hasEmbeddedApp) {
    const embedded =
      assets[pathname] ?? (pathname.endsWith('/') ? assets[`${pathname}index.html`] : undefined);
    if (embedded) return fileResponse(embedded, pathname);

    // Unknown path with a file extension is a genuine 404; everything else is a
    // client-side route, so hand back index.html.
    if (/\.[a-z0-9]+$/i.test(pathname)) {
      return new Response('Not found', { status: 404 });
    }
    const index = assets['/index.html'];
    if (index) return fileResponse(index, '/index.html');
    return new Response('Not found', { status: 404 });
  }

  if (isDev) return redirectToVite(url);

  return new Response(
    'The dashboard files are missing from this build. Reinstall Derailed from https://derailed.sh/install',
    { status: 500, headers: { 'content-type': 'text/plain' } },
  );
}

function fileResponse(embeddedPath: string, pathname: string): Response {
  const file = Bun.file(embeddedPath);
  const headers: Record<string, string> = {
    'content-type': file.type || 'application/octet-stream',
  };
  // Vite fingerprints everything under /assets/, so those can be cached forever.
  headers['cache-control'] = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  return new Response(file, { headers });
}

/**
 * Sends a browser that landed on the API port over to Vite.
 *
 * Forwarding the request instead was the old behaviour and looked tidier, but it
 * cannot work: Vite's client opens its HMR websocket against whichever origin served
 * the page, and that upgrade does not survive being relayed, so the page sat blank
 * while the client retried forever. A redirect puts the browser on the origin Vite
 * expects, which is the only place HMR can work.
 */
function redirectToVite(url: URL): Response {
  const target = new URL(url.pathname + url.search, VITE_ORIGIN);
  return new Response(null, { status: 302, headers: { location: target.href } });
}
