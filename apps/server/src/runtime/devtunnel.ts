import type { ServerWebSocket } from 'bun';
import { getSetting, SETTINGS } from '../db/repo/settings.ts';
import { appBaseDomain } from '../proxy/freedomain.ts';
import { newId } from '../util/ids.ts';

/**
 * Your laptop, on your domain.
 *
 * `derailed dev` serves the folder you are in through the server's address on a
 * temporary subdomain, so a client sees the work-in-progress without anything being
 * deployed. The laptop holds one control websocket to the panel; the panel routes a
 * throwaway subdomain to itself and, for each request that arrives on it, hands the
 * request down the socket, waits for the answer, and returns it. Nothing is built,
 * nothing is stored, and the moment the terminal is closed the subdomain is gone.
 *
 * The forwarding is buffered whole rather than streamed, on purpose: a preview of a
 * work-in-progress is small, and a buffered request is a hundred lines less to get
 * wrong than a streamed one. If that ever bites, it bites visibly, on a dev tunnel,
 * not in production.
 */

interface Pending {
  resolve: (response: DevResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DevData {
  kind: 'dev';
  userId: string;
  /** The subdomain label this laptop answers on, e.g. `sunny-fox`. */
  sub: string;
  /** What the person called it, for the dashboard's list. */
  label: string;
  pending: Map<string, Pending>;
}

interface DevResponse {
  status: number;
  headers: Record<string, string>;
  /** base64, so a binary body survives the JSON frame. */
  body: string;
}

/** One tunnel, as the rest of the server sees it. */
export interface DevTunnel {
  sub: string;
  userId: string;
  label: string;
}

const live = new Map<string, ServerWebSocket<DevData>>();

/** A friendly throwaway label: two words, no numbers to mistype down the phone. */
const ADJECTIVES = ['sunny', 'brave', 'calm', 'swift', 'lucky', 'quiet', 'clever', 'keen'];
const NOUNS = ['fox', 'otter', 'finch', 'maple', 'river', 'cedar', 'lark', 'reef'];

export function proposeSubdomain(): string {
  // Not Math.random (unavailable here); newId is the server's own entropy source.
  const id = newId();
  const a = ADJECTIVES[id.charCodeAt(0) % ADJECTIVES.length];
  const n = NOUNS[id.charCodeAt(1) % NOUNS.length];
  // The friendly two words are for saying down the phone; the guessing resistance is
  // all in the random tail. Four base36 chars (about 1.6M) is small enough to walk
  // through, and a live work-in-progress preview sitting on a guessable name is a
  // preview a stranger can read. Twelve chars is about 4.7e18, which is not walked.
  return `${a}-${n}-${id.slice(0, 12)}`;
}

/**
 * Put a tunnel on the map, under a name nothing else is using.
 *
 * `live.set(sub, ws)` on its own let a second tunnel that happened onto the same label
 * silently evict the first: its requests would suddenly be answered by someone else's
 * laptop. Vanishingly unlikely with a 12-char random tail, but "unlikely" is not
 * "cannot", and the cost of being sure is a loop that regenerates on the rare clash.
 * The laptop is told its name in the `ready` message *after* this returns, so moving
 * it here is invisible to the client.
 */
export function registerDev(ws: ServerWebSocket<DevData>): void {
  while (live.has(ws.data.sub)) ws.data.sub = proposeSubdomain();
  live.set(ws.data.sub, ws);
}

export function activeDevTunnels(): DevTunnel[] {
  return [...live.values()].map((ws) => ({
    sub: ws.data.sub,
    userId: ws.data.userId,
    label: ws.data.label,
  }));
}

export function hasDevTunnel(sub: string): boolean {
  return live.has(sub);
}

/**
 * The full address a dev subdomain answers on.
 *
 * Under the app base domain (or free address) when one is set, so the tunnel is
 * covered by the wildcard certificate that already exists and is real HTTPS. On a
 * bare box it is an sslip.io name off the server's IP: a working URL with no DNS
 * setup, plain HTTP, which is exactly right for showing someone a work-in-progress.
 */
export function devHostname(sub: string): string | null {
  const base = appBaseDomain();
  if (base) return `${sub}.${base}`;
  const serverIp = getSetting(SETTINGS.serverIp);
  if (!serverIp) return null;
  return `${sub}.${serverIp.replace(/\./g, '-')}.sslip.io`;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * One request for a dev subdomain, forwarded to the laptop and answered.
 *
 * Returns a plain 502 when the laptop is gone or slow, because a dev tunnel whose
 * far end vanished should say so rather than hang the browser.
 */
export async function forwardDevRequest(sub: string, request: Request): Promise<Response> {
  const ws = live.get(sub);
  if (!ws) {
    return new Response('That preview is not running any more.', { status: 502 });
  }

  // The endpoint is public and unauthenticated by design, so the size is checked from
  // the declared length *before* the body is pulled into memory: reading it first and
  // measuring after is how a flood of oversized requests exhausts the panel.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response('That upload is too big for a dev preview.', { status: 413 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    return new Response('That upload is too big for a dev preview.', { status: 413 });
  }

  const id = newId();
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    // The proxy marker never travels onward: it is between Caddy and the panel.
    if (!key.toLowerCase().startsWith('x-derailed-')) headers[key] = value;
  });

  const answer = new Promise<DevResponse>((resolve) => {
    const timer = setTimeout(() => {
      ws.data.pending.delete(id);
      resolve({
        status: 504,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('The laptop did not answer in time.').toString('base64'),
      });
    }, REQUEST_TIMEOUT_MS);
    ws.data.pending.set(id, { resolve, timer });
  });

  try {
    ws.send(
      JSON.stringify({
        id,
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body: body.byteLength ? Buffer.from(body).toString('base64') : null,
      }),
    );
  } catch {
    ws.data.pending.delete(id);
    return new Response('That preview could not be reached.', { status: 502 });
  }

  const response = await answer;
  return new Response(Buffer.from(response.body, 'base64'), {
    status: response.status,
    headers: response.headers,
  });
}

export const devHandlers = {
  open(ws: ServerWebSocket<DevData>): void {
    ws.data.pending = new Map();
    registerDev(ws);
    // A new subdomain needs a Caddy route before it answers. Dynamic import to
    // avoid a cycle with sync.ts, which lists the tunnels this module holds.
    void import('../proxy/sync.ts').then(({ syncRoutes }) => syncRoutes().catch(() => undefined));
    // The laptop learns the name and the address it was given, so it can print the URL.
    ws.send(
      JSON.stringify({ type: 'ready', sub: ws.data.sub, hostname: devHostname(ws.data.sub) }),
    );
  },

  message(ws: ServerWebSocket<DevData>, raw: string | Buffer): void {
    let message: { id?: string } & Partial<DevResponse>;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = ws.data.pending.get(message.id);
    if (!pending) return;
    ws.data.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      status: message.status ?? 502,
      headers: message.headers ?? {},
      body: message.body ?? '',
    });
  },

  close(ws: ServerWebSocket<DevData>): void {
    if (live.get(ws.data.sub) === ws) live.delete(ws.data.sub);
    for (const pending of ws.data.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 502, headers: {}, body: '' });
    }
    ws.data.pending.clear();
    // The subdomain is gone; take its route down so a stale name stops resolving.
    void import('../proxy/sync.ts').then(({ syncRoutes }) => syncRoutes().catch(() => undefined));
  },
};
