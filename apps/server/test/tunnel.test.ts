import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createToken } from '../src/db/repo/tokens.ts';
import { createApp } from '../src/http/app.ts';
import { ownerFromToken } from '../src/http/auth.ts';
import { proxySecret } from '../src/http/proxytrust.ts';
import { socketHandlers } from '../src/http/sockets.ts';
import { proposeSubdomain } from '../src/runtime/devtunnel.ts';
import { tunnelHandlers } from '../src/runtime/tunnel.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * The two laptop tunnels, driven through real websockets in-process.
 *
 * The byte-bridge for a database tunnel is proven against a plain TCP echo server
 * rather than Docker: what can go wrong is in the piping and the ordering, not in
 * which host is dialled, and the piping is the same whatever answers. The dev
 * tunnel is proven whole: a control socket registers, an HTTP request arrives
 * stamped the way Caddy stamps it, and the laptop's answer comes back.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-tunnel-'));
let app: ReturnType<typeof createApp>;
let token: string;
let secret: string;

// A TCP echo server standing in for a database container.
const echo = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket, chunk) {
      socket.write(chunk);
    },
    open() {},
    close() {},
    error() {},
  },
});

// The real server, with the same upgrade decisions serve.ts makes, so the socket
// handlers and the dev-forward path are the genuine ones.
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  secret = proxySecret();

  await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
  token = createToken('laptop').secret;

  server = Bun.serve({
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === '/api/tunnel' || url.pathname === '/api/dev') {
        const authed = ownerFromToken(request);
        if (!authed) return new Response('Unauthorized', { status: 401 });
        if (url.pathname === '/api/tunnel') {
          // Target points at the echo server; resolution itself is tested elsewhere.
          const upgraded = srv.upgrade(request, {
            data: {
              kind: 'tunnel',
              serviceId: 'x',
              target: { host: '127.0.0.1', port: echo.port },
              pending: [],
              open: false,
            },
          });
          return upgraded ? undefined : new Response('no upgrade', { status: 426 });
        }
        const upgraded = srv.upgrade(request, {
          data: {
            kind: 'dev',
            userId: authed.id,
            sub: proposeSubdomain(),
            label: 'x',
            pending: new Map(),
          },
        });
        return upgraded ? undefined : new Response('no upgrade', { status: 426 });
      }
      return app.fetch(request, { ip: srv.requestIP(request) });
    },
    websocket: socketHandlers,
  });
});

afterAll(() => {
  server.stop(true);
  echo.stop(true);
});

function base(): string {
  return `127.0.0.1:${server.port}`;
}

describe('a database tunnel', () => {
  test('carries bytes both ways, in order', async () => {
    const ws = new WebSocket(`ws://${base()}/api/tunnel?service=x`, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';

    const got: string[] = [];
    const done = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        got.push(new TextDecoder().decode(event.data as ArrayBuffer));
        if (got.join('').length >= 6) resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('tunnel would not open'));
    });

    ws.send(new TextEncoder().encode('foo'));
    ws.send(new TextEncoder().encode('bar'));
    await done;
    expect(got.join('')).toBe('foobar');
    ws.close();
  });

  test('refuses a handshake with no token', async () => {
    const response = await fetch(`http://${base()}/api/tunnel?service=x`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-key': 'x',
        'sec-websocket-version': '13',
      },
    }).catch(() => null);
    expect(response?.status).toBe(401);
  });
});

describe('a dev tunnel', () => {
  test('a request stamped the way Caddy stamps it reaches the laptop and comes back', async () => {
    const ws = new WebSocket(`ws://${base()}/api/dev?label=folder`, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);

    const sub = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; sub?: string };
        if (message.type === 'ready' && message.sub) resolve(message.sub);
      };
      ws.onerror = () => reject(new Error('dev socket would not open'));
    });

    // The laptop answers every forwarded request with a fixed page.
    ws.onmessage = (event) => {
      const request = JSON.parse(String(event.data)) as { id?: string; path?: string };
      if (!request.id) return;
      ws.send(
        JSON.stringify({
          id: request.id,
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-echo-path': request.path },
          body: Buffer.from(`hello from ${request.path}`).toString('base64'),
        }),
      );
    };

    // A request arriving the way the proxy delivers it: the dev marker and the secret.
    const response = await fetch(`http://${base()}/some/page`, {
      headers: {
        host: `${sub}.example.com`,
        'x-derailed-dev': sub,
        'x-derailed-proxy': secret,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-echo-path')).toBe('/some/page');
    expect(await response.text()).toBe('hello from /some/page');
    ws.close();
  });

  test('the dev marker is ignored unless it came through the proxy', async () => {
    // No proxy secret: a client forging the header gets the dashboard, not a laptop.
    const response = await fetch(`http://${base()}/`, {
      headers: { 'x-derailed-dev': 'someone-elses-tunnel' },
    });
    // The SPA (or its shell) answers, never the dev path.
    expect(response.headers.get('x-echo-path')).toBeNull();
    expect(response.status).toBeLessThan(500);
  });

  test('a request for a subdomain nobody is serving is a plain 502', async () => {
    const response = await fetch(`http://${base()}/`, {
      headers: { 'x-derailed-dev': 'ghost-tunnel', 'x-derailed-proxy': secret },
    });
    expect(response.status).toBe(502);
  });
});

describe('the pieces', () => {
  test('a proposed subdomain is two words and a tag, all url-safe', () => {
    expect(proposeSubdomain()).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  test('the tunnel handlers exist for the socket dispatcher', () => {
    expect(typeof tunnelHandlers.open).toBe('function');
    expect(typeof tunnelHandlers.message).toBe('function');
    expect(typeof tunnelHandlers.close).toBe('function');
  });

  test('a non-database service cannot be tunnelled', async () => {
    const project = createProject('Has an app');
    const appService = createAppService({
      projectId: project.id,
      name: 'web',
      source: 'image',
      image: 'nginx:alpine',
      repoUrl: null,
      branch: null,
    });
    const { tunnelTargetFor } = await import('../src/runtime/tunnel.ts');
    await expect(tunnelTargetFor(appService.id)).rejects.toThrow(/databases/i);
  });
});
