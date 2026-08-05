import { VERSION } from '../config.ts';
import { type Api, TOOLS } from './tools.ts';

/**
 * A Model Context Protocol server, so Claude Code, Cursor, Codex and friends can drive
 * a Derailed server in the same conversation where the code is being written.
 *
 * Speaks JSON-RPC 2.0 over stdin and stdout, which is all MCP's stdio transport is.
 * Implemented directly rather than pulling in an SDK: it is about a hundred lines, and
 * the binary is already 90 MB.
 *
 * It talks to Derailed over the ordinary HTTP API with an API token, so it can run on a
 * laptop against a server anywhere, and can never do anything the dashboard couldn't.
 */
interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

function makeApi(baseUrl: string, token: string): Api {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as { error?: { message?: string; hint?: string } })?.error;
      // The API's messages are already written for people, so pass them straight on.
      throw new Error(
        [error?.message ?? `Request failed (${response.status})`, error?.hint]
          .filter(Boolean)
          .join(' '),
      );
    }
    return payload as T;
  };

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
    put: (path, body) => call('PUT', path, body ?? {}),
    del: (path) => call('DELETE', path),
  };
}

export async function runMcpServer(): Promise<void> {
  const baseUrl = process.env.DERAILED_URL ?? 'http://127.0.0.1:8422';
  const token = process.env.DERAILED_TOKEN ?? '';

  // Anything written to stdout that isn't JSON-RPC corrupts the stream, so all
  // diagnostics go to stderr.
  const warn = (message: string) => process.stderr.write(`derailed-mcp: ${message}\n`);
  if (!token) warn('DERAILED_TOKEN is not set. Create one in Settings, under API access.');

  const api = makeApi(baseUrl, token);
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

  const reply = (id: Request['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Request['id'], code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(request: Request): Promise<void> {
    switch (request.method) {
      case 'initialize':
        reply(request.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'derailed', version: VERSION },
        });
        return;

      // Notifications carry no id and must not be answered.
      case 'notifications/initialized':
        return;

      case 'ping':
        reply(request.id, {});
        return;

      case 'tools/list':
        reply(request.id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        return;

      case 'tools/call': {
        const name = request.params?.name as string;
        const tool = TOOLS.find((entry) => entry.name === name);
        if (!tool) {
          fail(request.id, -32602, `There is no tool called "${name}".`);
          return;
        }
        try {
          const result = await tool.run(
            api,
            (request.params?.arguments ?? {}) as Record<string, unknown>,
          );
          reply(request.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          // Reported as a tool result rather than a protocol error, so the model can
          // read what went wrong and try something else.
          reply(request.id, {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          });
        }
        return;
      }

      default:
        if (request.id !== undefined && request.id !== null) {
          fail(request.id, -32601, `Unsupported method: ${request.method}`);
        }
    }
  }

  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      try {
        await handle(JSON.parse(line) as Request);
      } catch (err) {
        warn(`could not handle a message: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
