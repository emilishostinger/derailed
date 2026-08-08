import type { McpTool } from '../mcp/tools.ts';

/**
 * The model, spoken to plainly.
 *
 * Two dialects cover the whole market this feature serves: Anthropic's own, and
 * the OpenAI-compatible shape that OpenAI, Ollama, and nearly every self-hosted
 * runner answer. Raw fetch on principle, like the SMTP client and the MCP
 * server: an SDK per provider is real weight in a binary people download, for
 * two POST requests.
 *
 * The conversation lives in one neutral shape and is converted per dialect at
 * the door, so the browser, the loop and the tests never know which provider is
 * behind the curtain.
 */

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; id: string; name: string; result: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ProviderAnswer {
  text: string;
  toolCalls: ToolCall[];
}

export type Dialect = 'anthropic' | 'openai';

export interface ProviderSettings {
  dialect: Dialect;
  baseUrl: string;
  model: string;
  key: string | null;
}

/** The MCP tools, in each dialect's costume. */
export function anthropicTools(tools: McpTool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function openaiTools(tools: McpTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.id, content: message.result }],
      });
    }
  }
  return out;
}

export function toOpenaiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: message.id, content: message.result });
    }
  }
  return out;
}

interface AnthropicResponse {
  content?: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  )[];
  error?: { message?: string };
}

interface OpenaiResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  error?: { message?: string };
}

export function parseAnthropicAnswer(body: AnthropicResponse): ProviderAnswer {
  const text = (body.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolCalls = (body.content ?? [])
    .filter(
      (
        block,
      ): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        block.type === 'tool_use',
    )
    .map((block) => ({ id: block.id, name: block.name, args: block.input ?? {} }));
  return { text, toolCalls };
}

export function parseOpenaiAnswer(body: OpenaiResponse): ProviderAnswer {
  const message = body.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}') as Record<string, unknown>;
    } catch {
      // A model that produced unparsable arguments produced no arguments.
    }
    return { id: call.id, name: call.function?.name ?? '', args };
  });
  return { text: message?.content ?? '', toolCalls };
}

/** One turn with the model. Throws with the provider's own sentence on failure. */
export async function callProvider(
  settings: ProviderSettings,
  system: string,
  messages: ChatMessage[],
  tools: McpTool[],
): Promise<ProviderAnswer> {
  const base = settings.baseUrl.replace(/\/+$/, '');

  if (settings.dialect === 'anthropic') {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.key ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 1024,
        system,
        messages: toAnthropicMessages(messages),
        tools: anthropicTools(tools),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as AnthropicResponse;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `The model answered ${response.status}.`);
    }
    return parseAnthropicAnswer(body);
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(settings.key ? { authorization: `Bearer ${settings.key}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'system', content: system }, ...toOpenaiMessages(messages)],
      tools: openaiTools(tools),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => ({}))) as OpenaiResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `The model answered ${response.status}.`);
  }
  return parseOpenaiAnswer(body);
}
