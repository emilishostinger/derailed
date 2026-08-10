import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { topics } from '@derailed/shared';
import { paths } from '../config.ts';
import { listDomains } from '../db/repo/domains.ts';
import { listServices } from '../db/repo/services.ts';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';

/**
 * Screenshots are on unless somebody turned them off: an absent setting means yes.
 * The stored value stays a plain boolean string, so a toggle written by an older
 * version keeps meaning what it meant.
 */
export function previewShotsEnabled(): boolean {
  return getSetting(SETTINGS.previewShots) !== 'false';
}

import { imageExists, pullImage } from '../docker/images.ts';
import { publish } from '../events/bus.ts';
import { caddyHttpPort } from '../proxy/caddy.ts';

/**
 * What each app actually looks like.
 *
 * A dashboard listing seven apps by name, status dot and framework icon is a process
 * list. The same seven with their own titles and icons on them is a shelf of things
 * you made, and that difference is most of how it feels to use this.
 *
 * Two levels, because they cost wildly different amounts. The title and the icon come
 * from one HTTP request to a site that is already running, which is free and always
 * on. A screenshot needs a browser, which is a 300 MB image nobody should be made to
 * download to see a list, so it is a setting.
 */

export interface Preview {
  serviceId: string;
  /** The site's own `<title>`, when it has one worth showing. */
  title: string | null;
  /** Path under `/api/previews/`, or null when there isn't one yet. */
  iconPath: string | null;
  shotPath: string | null;
  at: number;
}

const CHROME_IMAGE = 'zenika/alpine-chrome:latest';

function previewsDir(): string {
  return join(paths.dataDir, 'previews');
}

/**
 * Which name to look at, and how to reach it.
 *
 * The hostname is the one a visitor would type. The request, though, goes to the
 * proxy on loopback carrying that name as a `Host` header rather than out to the
 * public address and back. Three reasons, all of which broke this the first time
 * round: the name may not resolve from the server itself, a router may refuse to
 * hairpin a connection to its own public address, and neither has anything to do
 * with whether the site works for the people it is for.
 */
export function previewTarget(serviceId: string): { hostname: string; url: string } | null {
  const domains = listDomains(serviceId);
  const best =
    domains.find((domain) => domain.kind === 'custom' && domain.tlsStatus === 'active') ??
    domains.find((domain) => domain.tlsStatus === 'active') ??
    domains.find((domain) => domain.dnsStatus === 'ok') ??
    domains[0];
  if (!best) return null;

  // Always plain HTTP to the proxy: Caddy serves the same page either way, and going
  // over HTTPS to loopback would fail certificate validation on the name every time.
  return { hostname: best.hostname, url: `http://127.0.0.1:${caddyHttpPort()}/` };
}

/**
 * Pulls the title and the icon out of a page.
 *
 * Deliberately forgiving: a site that answers 500, redirects somewhere odd or serves
 * no HTML at all is still a perfectly good app, and this is decoration. Anything that
 * goes wrong means "no preview", never an error anybody sees.
 */
async function fetchMetadata(target: {
  hostname: string;
  url: string;
}): Promise<{ title: string | null; icon: { bytes: Uint8Array; type: string } | null }> {
  const response = await fetch(target.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: { 'user-agent': 'Derailed/preview', host: target.hostname },
  });
  const html = await response.text();

  const rawTitle = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? '';
  const title =
    rawTitle
      .replace(/\s+/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .trim()
      .slice(0, 120) || null;

  const href =
    html
      .match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i)?.[0]
      ?.match(/href=["']([^"']+)["']/i)?.[1] ?? '/favicon.ico';

  let icon: { bytes: Uint8Array; type: string } | null = null;
  try {
    // Resolved against the site's own name, then fetched back through loopback the
    // same way. Only a path on this site is ever followed: an absolute URL elsewhere
    // would mean this server fetching whatever a deployed app pointed it at.
    const wanted = new URL(href, `http://${target.hostname}/`);
    if (wanted.host === target.hostname) {
      const iconResponse = await fetch(new URL(wanted.pathname + wanted.search, target.url), {
        signal: AbortSignal.timeout(5000),
        headers: { host: target.hostname },
      });
      if (iconResponse.ok) {
        const bytes = new Uint8Array(await iconResponse.arrayBuffer());
        // Anything larger is not a favicon, and is not going on a tile.
        if (bytes.byteLength > 0 && bytes.byteLength < 512 * 1024) {
          icon = { bytes, type: iconResponse.headers.get('content-type') ?? 'image/x-icon' };
        }
      }
    }
  } catch {
    // No icon. Not a problem.
  }

  return { title, icon };
}

/**
 * Takes a picture of a page with a throwaway headless Chrome.
 *
 * One-shot rather than a long-running browser: a container that exists for four
 * seconds a few times an hour costs nothing, and a browser sitting resident on a 1 GB
 * server to occasionally take a photo would be an absurd trade.
 */
async function capture(target: { hostname: string; url: string }, into: string): Promise<boolean> {
  if (!(await imageExists(CHROME_IMAGE))) {
    await pullImage(CHROME_IMAGE).catch(() => undefined);
    if (!(await imageExists(CHROME_IMAGE))) return false;
  }

  const proc = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      `${previewsDir()}:/out`,
      CHROME_IMAGE,
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--window-size=1200,750',
      '--screenshot=/out/.capturing.png',
      '--virtual-time-budget=6000',
      // Same trick as the metadata fetch: the browser is pointed at the real name so
      // the site sees the host it expects, and that name is resolved to the proxy on
      // this machine rather than out to the internet and back.
      `--host-resolver-rules=MAP ${target.hostname} 127.0.0.1`,
      `http://${target.hostname}:${caddyHttpPort()}/`,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );

  const timer = setTimeout(() => proc.kill(), 45_000);
  const code = await proc.exited;
  clearTimeout(timer);

  const temporary = join(previewsDir(), '.capturing.png');
  if (code !== 0) {
    await rm(temporary, { force: true });
    return false;
  }

  const info = await stat(temporary).catch(() => null);
  if (!info || info.size === 0) {
    await rm(temporary, { force: true });
    return false;
  }

  await Bun.write(into, Bun.file(temporary));
  await rm(temporary, { force: true });
  return true;
}

/** Refreshes one app's preview. Returns what it managed to get. */
export async function refreshPreview(serviceId: string): Promise<Preview | null> {
  const target = previewTarget(serviceId);
  if (!target) return null;

  await mkdir(previewsDir(), { recursive: true, mode: 0o700 });
  const preview: Preview = {
    serviceId,
    title: null,
    iconPath: null,
    shotPath: null,
    at: Date.now(),
  };

  try {
    const { title, icon } = await fetchMetadata(target);
    preview.title = title;
    if (icon) {
      const file = join(previewsDir(), `${serviceId}-icon`);
      await writeFile(file, icon.bytes);
      await writeFile(`${file}.type`, icon.type);
      preview.iconPath = `${serviceId}-icon`;
    }
  } catch {
    // The site is not answering. Keep whatever was there from last time.
  }

  if (previewShotsEnabled()) {
    const shot = join(previewsDir(), `${serviceId}-shot.png`);
    if (await capture(target, shot).catch(() => false)) {
      preview.shotPath = `${serviceId}-shot.png`;
    }
  }

  await writeFile(join(previewsDir(), `${serviceId}.json`), JSON.stringify(preview));
  publish(topics.service(serviceId), { type: 'preview', serviceId });
  return preview;
}

/**
 * Read synchronously, because `presentService` is synchronous and every service in
 * every list goes through it. The file is a few hundred bytes and the OS has it
 * cached; making the whole presentation layer async to avoid that would be a far
 * larger change than the cost it saves.
 */
export function readPreview(serviceId: string): Preview | null {
  try {
    return JSON.parse(readFileSync(join(previewsDir(), `${serviceId}.json`), 'utf8')) as Preview;
  } catch {
    return null;
  }
}

/** The bytes for one preview file, for the route that serves them. */
export async function previewFile(
  name: string,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  // Only ever a name this module wrote: no separators, no dots, nothing that could
  // walk out of the folder. The name comes off a URL, so it is not to be trusted.
  if (!/^[A-Za-z0-9-]+(\.png)?$/.test(name)) return null;

  const file = join(previewsDir(), name);
  try {
    const bytes = new Uint8Array(await readFile(file));
    const type = name.endsWith('.png')
      ? 'image/png'
      : ((await readFile(`${file}.type`, 'utf8').catch(() => '')) || 'image/x-icon').split(';')[0]!;
    return { bytes, type };
  } catch {
    return null;
  }
}

export async function forgetPreview(serviceId: string): Promise<void> {
  for (const suffix of ['.json', '-icon', '-icon.type', '-shot.png']) {
    await rm(join(previewsDir(), `${serviceId}${suffix}`), { force: true }).catch(() => undefined);
  }
}

/** Every app that is worth looking at: running, and with an address. */
function previewable(): string[] {
  return listServices()
    .filter((service) => service.kind === 'app' && service.instancesDesired === 1)
    .filter((service) => previewTarget(service.id) !== null)
    .map((service) => service.id);
}

async function sweep(): Promise<void> {
  for (const serviceId of previewable()) {
    await refreshPreview(serviceId).catch(() => undefined);
  }
}

/** Often enough to feel current, rarely enough to be invisible. */
const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startPreviews(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  // A minute after boot rather than immediately: at boot the apps are still starting,
  // and a screenshot of a site that is not up yet is worse than no screenshot.
  setTimeout(() => void sweep(), 60_000).unref?.();
}

export function stopPreviews(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
