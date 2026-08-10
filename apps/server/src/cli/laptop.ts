import { mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';

/**
 * The laptop half of Derailed: `derailed dev` and `derailed tunnel`.
 *
 * Unlike every other command, these talk to a server over the network rather than
 * to the database beside them, because the whole point is to run on a laptop and
 * reach the box. They read one small config, written by `derailed login`, holding
 * the server's address and an API token.
 */

interface LaptopConfig {
  url: string;
  token: string;
}

function configPath(): string {
  return join(homedir(), '.derailed', 'config.json');
}

async function loadConfig(): Promise<LaptopConfig> {
  // The environment wins, so a CI job or a one-off can pass them without a file.
  const url = process.env.DERAILED_URL;
  const token = process.env.DERAILED_TOKEN;
  if (url && token) return { url: url.replace(/\/$/, ''), token };

  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<LaptopConfig>;
    if (parsed.url && parsed.token) {
      return { url: parsed.url.replace(/\/$/, ''), token: parsed.token };
    }
  } catch {
    // fall through to the friendly error
  }
  console.error('Not signed in to a server yet. Run:  derailed login <https://your-server>');
  process.exit(1);
}

function wsUrl(httpUrl: string, path: string): string {
  return httpUrl.replace(/^http/, 'ws') + path;
}

/** `derailed login <url>` stores the address and a token for the two commands above. */
export async function login(url?: string): Promise<void> {
  if (!url) {
    console.error('Usage: derailed login <https://your-server>');
    process.exit(1);
  }
  const clean = url.replace(/\/$/, '');
  const token =
    process.env.DERAILED_TOKEN || prompt('Paste an API token (Settings on the server):');
  if (!token?.startsWith('drl_')) {
    console.error('That does not look like a Derailed API token. Nothing was saved.');
    process.exit(1);
  }

  // Prove it before saving, so a wrong paste fails now rather than at first use.
  const response = await fetch(`${clean}/api/system`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) {
    console.error(`Could not sign in to ${clean}. Check the address and the token.`);
    process.exit(1);
  }

  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify({ url: clean, token }, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Signed in to ${clean}.`);
}

/** Finds a database by whatever the person typed, through the API. */
async function findDatabaseId(config: LaptopConfig, needle: string): Promise<string> {
  const response = await fetch(`${config.url}/api/projects`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    console.error('Could not reach the server. Is the address right, and the token still valid?');
    process.exit(1);
  }
  const body = (await response.json()) as {
    projects: { services?: { id: string; name: string; slug: string; kind: string }[] }[];
  };
  const wanted = needle.trim().toLowerCase();
  const matches = body.projects
    .flatMap((project) => project.services ?? [])
    .filter(
      (service) =>
        service.kind === 'database' &&
        (service.slug.toLowerCase() === wanted || service.name.toLowerCase() === wanted),
    );
  if (matches.length === 0) {
    console.error(`No database here is called "${needle}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`More than one database is called "${needle}". Use its exact slug.`);
    process.exit(1);
  }
  return matches[0]!.id;
}

/**
 * `derailed tunnel <db> [--port N]`: a local port that reaches the database over a
 * websocket, so TablePlus (or psql, or anything) connects to localhost and no port
 * is ever opened to the internet.
 */
export async function tunnel(argv: string[]): Promise<void> {
  const name = argv.find((arg) => !arg.startsWith('-'));
  if (!name) {
    console.error('Usage: derailed tunnel <database> [--port 6543]');
    process.exit(1);
  }
  const portArg = argv[argv.indexOf('--port') + 1];
  const localPort = argv.includes('--port') ? Number(portArg) : 6543;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    console.error('The --port has to be a number between 1 and 65535.');
    process.exit(1);
  }

  const config = await loadConfig();
  const serviceId = await findDatabaseId(config, name);

  const server = Bun.listen<{ ws: WebSocket | null; queue: Uint8Array[] }>({
    hostname: '127.0.0.1',
    port: localPort,
    socket: {
      open(socket) {
        socket.data = { ws: null, queue: [] };
        const ws = new WebSocket(
          wsUrl(config.url, `/api/tunnel?service=${encodeURIComponent(serviceId)}`),
          { headers: { authorization: `Bearer ${config.token}` } } as unknown as string[],
        );
        ws.binaryType = 'arraybuffer';
        socket.data.ws = ws;
        ws.onmessage = (event) => {
          const data =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : new TextEncoder().encode(String(event.data));
          socket.write(data);
        };
        ws.onopen = () => {
          for (const chunk of socket.data.queue) ws.send(chunk);
          socket.data.queue = [];
        };
        ws.onclose = () => socket.end();
        ws.onerror = () => socket.end();
      },
      data(socket, chunk) {
        const ws = socket.data.ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
        else socket.data.queue.push(new Uint8Array(chunk));
      },
      close(socket) {
        socket.data.ws?.close();
      },
    },
  });

  console.log(`\n  ${name} is at  127.0.0.1:${server.port}`);
  console.log('  Point TablePlus, psql or anything else there. Ctrl-C to close the tunnel.\n');
  // Keep the process alive; Bun.listen does not on its own.
  await new Promise(() => {});
}

interface DevRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * `derailed dev [--port N] [--dir D]`: the folder you are in, on a temporary
 * subdomain of the server, so a client sees the work without a deploy. Serves a
 * local folder itself, or forwards to a dev server already running on `--port`.
 */
export async function dev(argv: string[]): Promise<void> {
  const config = await loadConfig();
  const portArg = argv[argv.indexOf('--port') + 1];
  const forwardPort = argv.includes('--port') ? Number(portArg) : null;
  const dirArg = argv[argv.indexOf('--dir') + 1];
  const dir = resolve(argv.includes('--dir') ? (dirArg ?? '.') : '.');
  const label = forwardPort ? `localhost:${forwardPort}` : dir;

  const ws = new WebSocket(wsUrl(config.url, `/api/dev?label=${encodeURIComponent(label)}`), {
    headers: { authorization: `Bearer ${config.token}` },
  } as unknown as string[]);

  ws.onopen = () => {
    console.log(forwardPort ? `\n  Sharing localhost:${forwardPort}…` : `\n  Sharing ${dir}…`);
  };
  ws.onclose = () => {
    console.error('\n  The tunnel closed.');
    process.exit(1);
  };
  ws.onerror = () => {
    console.error('\n  Could not open the tunnel. Is the server reachable and the token valid?');
    process.exit(1);
  };

  ws.onmessage = async (event) => {
    let message: DevRequest | { type: string; hostname?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if ('type' in message && message.type === 'ready') {
      console.log(`  Live at  https://${message.hostname}\n  Ctrl-C to stop.\n`);
      return;
    }
    const request = message as DevRequest;
    if (!request.id) return;

    const answer = forwardPort
      ? await answerFromPort(request, forwardPort)
      : await answerFromDir(request, dir);
    ws.send(JSON.stringify({ id: request.id, ...answer }));
  };

  await new Promise(() => {});
}

async function answerFromPort(
  request: DevRequest,
  port: number,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body ? Buffer.from(request.body, 'base64') : undefined,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = Buffer.from(await response.arrayBuffer()).toString('base64');
    return { status: response.status, headers, body };
  } catch {
    return notReached(`Nothing is answering on localhost:${port}.`);
  }
}

async function answerFromDir(
  request: DevRequest,
  dir: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  // The path, forced back inside the served folder: a request for `/../secret` is a
  // request for a 404, not a way out of the directory.
  const rawPath = decodeURIComponent(request.path.split('?')[0] ?? '/');
  const rel = normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  let target = join(dir, rel);
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) target = join(target, 'index.html');
  if (!resolve(target).startsWith(resolve(dir))) {
    return notReached('That path is outside the shared folder.');
  }

  const file = Bun.file(target);
  if (!(await file.exists())) return notReached('Not found in the shared folder.', 404);
  const body = Buffer.from(await file.arrayBuffer()).toString('base64');
  return {
    status: 200,
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body,
  };
}

function notReached(
  message: string,
  status = 502,
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from(message).toString('base64'),
  };
}
