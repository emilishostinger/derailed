import { Hono } from 'hono';
import {
  assistReady,
  assistSettings,
  executeTool,
  findTool,
  runAssist,
  saveAssistSettings,
} from '../../assist/assist.ts';
import type { ChatMessage } from '../../assist/provider.ts';
import type { Api } from '../../mcp/tools.ts';
import type { AppEnv } from '../auth.ts';
import { clientIp, RateLimiter } from '../auth.ts';
import { badRequest } from '../errors.ts';

/**
 * Ask your server: the chat, the confirm button, and the settings.
 *
 * The settings are owner-only including reads (the role table covers /assist
 * writes; the key itself is never returned to anyone). The chat is for every
 * role, because each tool call runs through the ordinary API as the person
 * asking: a viewer's assistant sees what a viewer sees.
 */
export const assistRoutes = new Hono<AppEnv>();

/**
 * The caller's own hands. Every tool call becomes an ordinary HTTP request
 * against this same server, carrying the caller's session cookie, so the role
 * table, the audit log and every guard apply exactly as if they had clicked.
 */
let inner: { fetch: (request: Request) => Response | Promise<Response> } | null = null;

function callerApi(headers: { cookie?: string; authorization?: string }): Api {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    // Imported at call time: this module is itself part of the app being built.
    if (!inner) {
      const { createApp } = await import('../app.ts');
      inner = createApp();
    }
    const response = await inner.fetch(
      new Request(`http://assist.internal/api${path}`, {
        method,
        headers: {
          ...(headers.cookie ? { cookie: headers.cookie } : {}),
          ...(headers.authorization ? { authorization: headers.authorization } : {}),
          'x-requested-with': 'derailed',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
    const parsed = (await response.json().catch(() => ({}))) as T & {
      error?: { message?: string; hint?: string };
    };
    if (!response.ok) {
      const message = parsed.error?.message ?? `The API answered ${response.status}.`;
      throw new Error(parsed.error?.hint ? `${message} ${parsed.error.hint}` : message);
    }
    return parsed;
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    del: (path) => request('DELETE', path),
  };
}

const MAX_TRANSCRIPT = 60;

function validTranscript(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRANSCRIPT) return null;
  for (const entry of value as ChatMessage[]) {
    if (entry.role === 'user' || entry.role === 'assistant') {
      if (typeof entry.text !== 'string' || entry.text.length > 20_000) return null;
    } else if (entry.role === 'tool') {
      if (typeof entry.id !== 'string' || typeof entry.result !== 'string') return null;
    } else {
      return null;
    }
  }
  return value as ChatMessage[];
}

// Every other cost-bearing endpoint has one; this one spends the owner's AI key
// and holds slow outbound fetches, so a viewer must not be able to loop it.
const assistLimiter = new RateLimiter(20, 60_000);

/** One turn: the model reads what it needs and answers, or proposes one change. */
assistRoutes.post('/', async (c) => {
  if (!assistLimiter.check(clientIp(c))) {
    throw badRequest('That is a lot of questions at once. Give it a minute.');
  }
  if (!assistReady()) {
    throw badRequest(
      'Nothing is set up to think with.',
      'An owner can add an AI key, or point Derailed at an Ollama, in the Ask settings.',
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { messages?: unknown };
  const transcript = validTranscript(body.messages);
  if (!transcript) throw badRequest('That conversation did not make sense.');

  const hands = callerApi({
    cookie: c.req.header('cookie'),
    authorization: c.req.header('authorization'),
  });
  const outcome = await runAssist(transcript, hands).catch((err) => {
    throw badRequest(
      'The model could not be reached.',
      err instanceof Error ? err.message : String(err),
    );
  });
  return c.json(outcome);
});

/** The confirm button: one write, run as the person who pressed it. */
assistRoutes.post('/execute', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  if (typeof body.id !== 'string' || typeof body.name !== 'string' || !body.name) {
    throw badRequest('Which action?');
  }
  // Only a real tool may be run here. The name came from the browser, and while
  // executeTool re-enters the role table as the caller anyway (so this is not an
  // escalation), an endpoint named "execute" should not proxy arbitrary strings.
  if (!findTool(body.name)) throw badRequest('That is not an action Derailed knows.');

  const result = await executeTool(
    { id: body.id, name: body.name, args: body.args ?? {} },
    callerApi({
      cookie: c.req.header('cookie'),
      authorization: c.req.header('authorization'),
    }),
  );
  return c.json({ message: result });
});

assistRoutes.get('/settings', (c) => {
  const settings = assistSettings();
  // The address the key is sent to is internal topology; a non-owner needs only
  // to know whether the assistant is set up at all, so they see readiness, not
  // where a self-hosted model lives.
  if (c.get('user').role !== 'owner') {
    return c.json({ provider: settings.provider, model: settings.model, hasKey: settings.hasKey });
  }
  return c.json(settings);
});

assistRoutes.put('/settings', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: 'anthropic' | 'openai' | 'ollama' | 'custom';
    model?: string;
    baseUrl?: string;
    key?: string;
  };
  if (body.provider && !['anthropic', 'openai', 'ollama', 'custom'].includes(body.provider)) {
    throw badRequest('Derailed does not know that provider.');
  }
  // An empty string previously slipped past this check and stored a blank address
  // that later threw an opaque invalid-URL error at request time. It is required.
  if (body.baseUrl !== undefined && !/^https?:\/\/\S/.test(body.baseUrl.trim())) {
    throw badRequest('The address has to start with http:// or https://.');
  }
  return c.json(saveAssistSettings(body));
});
