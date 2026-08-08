import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assistReady,
  assistSettings,
  isWriteTool,
  saveAssistSettings,
  WRITE_TOOLS,
} from '../src/assist/assist.ts';
import {
  parseAnthropicAnswer,
  parseOpenaiAnswer,
  toAnthropicMessages,
  toOpenaiMessages,
} from '../src/assist/provider.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { getSetting, SETTINGS } from '../src/db/repo/settings.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Ask your server. The properties that matter are about power, not prose: every
 * tool the model runs is the caller's own API call, a write never runs without
 * a press, an unknown tool counts as a write, and the key never comes back out.
 * The model itself is a scripted stub, because what is under test is the leash.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-assist-'));
let app: ReturnType<typeof createApp>;
let cookie = '';

/** A scripted OpenAI-compatible model: answers from a queue, records requests. */
const script: unknown[] = [];
const seenRequests: unknown[] = [];
const stub = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seenRequests.push(await request.json());
    const next = script.shift() ?? {
      choices: [{ message: { content: 'The script ran out.' } }],
    };
    return Response.json(next);
  },
});

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const setup = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  createProject('Lighthouse');
});

afterAll(async () => {
  stub.stop(true);
  closeDb();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function ask(messages: unknown) {
  return app.request('/api/assist', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
    body: JSON.stringify({ messages }),
  });
}

describe('the leash', () => {
  test('every tool is classified, and an unknown tool counts as a write', () => {
    for (const name of WRITE_TOOLS) {
      expect(TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
    for (const tool of TOOLS) {
      expect(typeof isWriteTool(tool.name)).toBe('boolean');
    }
    // The failure mode that matters: a tool nobody classified must not run free.
    expect(isWriteTool('brand_new_tool_from_the_future')).toBe(true);
    // And the obviously dangerous ones are where they belong.
    expect(isWriteTool('run_command')).toBe(true);
    expect(isWriteTool('deploy')).toBe(true);
    expect(isWriteTool('list_projects')).toBe(false);
    expect(isWriteTool('get_logs')).toBe(false);
  });

  test('who may do what: chatting is looking, settings are the owner’s', () => {
    expect(mayCall('viewer', 'POST', '/api/assist').ok).toBe(true);
    expect(mayCall('viewer', 'POST', '/api/assist/execute').ok).toBe(false);
    expect(mayCall('member', 'POST', '/api/assist').ok).toBe(true);
    expect(mayCall('member', 'PUT', '/api/assist/settings').ok).toBe(false);
    expect(mayCall('owner', 'PUT', '/api/assist/settings').ok).toBe(true);
  });
});

describe('the settings', () => {
  test('the key is stored encrypted and never comes back out', () => {
    const saved = saveAssistSettings({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      key: 'sk-ant-very-secret',
    });
    expect(saved.hasKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('sk-ant');
    expect(getSetting(SETTINGS.aiKey)).not.toContain('sk-ant');
    expect(assistReady()).toBe(true);
  });

  test('the paid providers need a key; an Ollama needs only an address and a model', () => {
    saveAssistSettings({ provider: 'anthropic', model: 'claude-sonnet-5', key: '' });
    expect(assistReady()).toBe(false);
    saveAssistSettings({ provider: 'ollama', model: 'llama3.3' });
    expect(assistReady()).toBe(true);
    expect(assistSettings().baseUrl).toContain('11434');
  });

  test('unconfigured, the chat says what is missing instead of failing strangely', async () => {
    saveAssistSettings({ provider: 'anthropic', model: '', key: '' });
    const answer = await ask([{ role: 'user', text: 'hello' }]);
    expect(answer.status).toBe(400);
    expect(await answer.text()).toContain('set up to think with');
  });
});

describe('the two dialects', () => {
  const transcript = [
    { role: 'user' as const, text: 'restart the blog' },
    {
      role: 'assistant' as const,
      text: 'Looking first.',
      toolCalls: [{ id: 'c1', name: 'list_projects', args: {} }],
    },
    { role: 'tool' as const, id: 'c1', name: 'list_projects', result: '[]' },
  ];

  test('anthropic in, anthropic out', () => {
    const messages = toAnthropicMessages(transcript) as {
      role: string;
      content: unknown;
    }[];
    expect(messages[0]).toEqual({ role: 'user', content: 'restart the blog' });
    expect(JSON.stringify(messages[1])).toContain('tool_use');
    expect(JSON.stringify(messages[2])).toContain('tool_result');

    const parsed = parseAnthropicAnswer({
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'x', name: 'deploy', input: { app: 'blog' } },
      ],
    });
    expect(parsed.text).toBe('On it.');
    expect(parsed.toolCalls).toEqual([{ id: 'x', name: 'deploy', args: { app: 'blog' } }]);
  });

  test('openai in, openai out, including arguments that fail to parse', () => {
    const messages = toOpenaiMessages(transcript) as Record<string, unknown>[];
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '[]' });

    const parsed = parseOpenaiAnswer({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'y', function: { name: 'get_logs', arguments: '{"service":"blog"}' } },
              { id: 'z', function: { name: 'deploy', arguments: 'not json' } },
            ],
          },
        },
      ],
    });
    expect(parsed.toolCalls[0]).toEqual({ id: 'y', name: 'get_logs', args: { service: 'blog' } });
    expect(parsed.toolCalls[1]!.args).toEqual({});
  });
});

describe('a conversation against the scripted model', () => {
  beforeAll(() => {
    saveAssistSettings({
      provider: 'custom',
      model: 'stub-model',
      baseUrl: `http://127.0.0.1:${stub.port}`,
      key: '',
    });
  });

  test('a read runs by itself, as the caller, and the answer comes back grounded', async () => {
    script.length = 0;
    script.push(
      {
        choices: [
          {
            message: {
              content: 'Let me look.',
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: { name: 'list_projects', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: 'You have one project: Lighthouse.' } }] },
    );

    const answer = await ask([{ role: 'user', text: 'what projects do I have?' }]);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      messages: { role: string; result?: string; text?: string }[];
      proposal: unknown;
    };
    expect(body.proposal).toBeNull();

    // The tool really ran against the real API: its result names the project.
    const toolResult = body.messages.find((message) => message.role === 'tool');
    expect(toolResult?.result).toContain('Lighthouse');
    expect(body.messages.at(-1)?.text).toContain('Lighthouse');

    // And the model was told about the tools in its own dialect.
    const first = seenRequests.at(-2) as { tools: { function: { name: string } }[] };
    expect(first.tools.some((tool) => tool.function.name === 'list_projects')).toBe(true);
  });

  test('a write becomes a card, not an action', async () => {
    script.length = 0;
    script.push({
      choices: [
        {
          message: {
            content: 'I can restart it.',
            tool_calls: [
              {
                id: 't2',
                type: 'function',
                function: {
                  name: 'control_service',
                  arguments: '{"service":"blog","action":"restart"}',
                },
              },
            ],
          },
        },
      ],
    });

    const answer = await ask([{ role: 'user', text: 'restart the blog' }]);
    const body = (await answer.json()) as {
      proposal: { name: string; args: Record<string, unknown>; what: string } | null;
      messages: { role: string }[];
    };
    expect(body.proposal).not.toBeNull();
    expect(body.proposal!.name).toBe('control_service');
    expect(body.proposal!.args).toEqual({ service: 'blog', action: 'restart' });
    expect(body.proposal!.what.length).toBeGreaterThan(10);
    // Nothing executed: no tool result in what came back.
    expect(body.messages.some((message) => message.role === 'tool')).toBe(false);
  });

  test('the confirm button runs the write as the person, refusals included', async () => {
    const answer = await app.request('/api/assist/execute', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        id: 't2',
        name: 'control_service',
        args: { service: 'no-such-app', action: 'restart' },
      }),
    });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { message: { role: string; result: string } };
    expect(body.message.role).toBe('tool');
    // The tool ran, met the real API, and brought back the real refusal.
    expect(body.message.result).toContain('no-such-app');
  });

  test('a model that never stops asking is stopped', async () => {
    script.length = 0;
    for (let i = 0; i < 10; i++) {
      script.push({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: `loop${i}`,
                  type: 'function',
                  function: { name: 'list_projects', arguments: '{}' },
                },
              ],
            },
          },
        ],
      });
    }
    const answer = await ask([{ role: 'user', text: 'dig forever' }]);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { messages: { role: string; text?: string }[] };
    expect(body.messages.at(-1)?.text).toContain('more narrowly');
  });
});
