import { isDev } from '../config.ts';
import { assets } from '../generated/assets.ts';

const VITE_ORIGIN = process.env.DERAILED_VITE_ORIGIN ?? 'http://localhost:5173';

export const hasEmbeddedApp = Object.keys(assets).length > 0;

/**
 * Serves the React app.
 *
 * Production: files are embedded in the binary (`with { type: 'file' }`), so this is
 * just a map lookup. Development: proxy through to the Vite dev server so HMR works
 * when someone opens :8422 directly.
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

  if (isDev) return proxyToVite(request, url);

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

async function proxyToVite(request: Request, url: URL): Promise<Response> {
  const target = new URL(url.pathname + url.search, VITE_ORIGIN);
  try {
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });
  } catch {
    return new Response(
      `Derailed is running, but the dashboard dev server isn't.\n\nStart it with: bun dev\nOr open ${VITE_ORIGIN} directly.\n`,
      { status: 502, headers: { 'content-type': 'text/plain' } },
    );
  }
}
