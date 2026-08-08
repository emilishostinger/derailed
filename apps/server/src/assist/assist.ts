import { VERSION } from '../config.ts';
import { deleteSetting, getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import type { Api, McpTool } from '../mcp/tools.ts';
import { TOOLS } from '../mcp/tools.ts';
import { decrypt, encrypt } from '../util/crypto.ts';
import {
  type ChatMessage,
  callProvider,
  type Dialect,
  type ProviderSettings,
  type ToolCall,
} from './provider.ts';

/**
 * Ask your server.
 *
 * A chat box in the dashboard, powered by the person's own AI key or their own
 * Ollama, driving the same tools coding agents already use over MCP. Nothing
 * here is a second brain with its own powers:
 *
 * - **Reads run as the person asking.** Every tool call goes through the
 *   ordinary HTTP API with the caller's own session, so the role table and the
 *   audit log apply exactly as if they had clicked. A viewer's assistant can
 *   see what a viewer can see, and no more.
 * - **Writes wait for a press.** A tool that changes anything comes back as a
 *   proposed action with the exact tool and arguments on the screen, and runs
 *   only when the person confirms, again as themselves, again audited.
 * - **The key is the person's.** Anthropic, OpenAI, or an Ollama on the box;
 *   encrypted at rest, never returned, and never a dependency: three fetches of
 *   plain JSON, not an SDK per provider.
 */

/**
 * The tools that change something. Everything else answers questions. A tool
 * added later lands here or it lands behind the confirm button by default,
 * because `WRITE_TOOLS.has(name)` failing open would be a self-driving server.
 */
export const WRITE_TOOLS = new Set([
  'deploy',
  'control_service',
  'deploy_from_github',
  'install_app',
  'create_project',
  'add_database',
  'set_variables',
  'add_domain',
  'add_storage',
  'back_up_now',
  'add_job',
  'run_job',
  'run_command',
  // Re-resolves DNS and can trigger a certificate attempt: a change, not a look.
  'check_domain',
]);

/**
 * Reads that hand back a live secret rather than a view of one. They run as the
 * caller, so the caller was already allowed to see the value; the extra gate is
 * because auto-running them ships every secret to a third-party model with no
 * press, which is a different act from reading one in the dashboard.
 */
export const SECRET_TOOLS = new Set(['get_variables']);

export function isWriteTool(name: string): boolean {
  // Unknown names are writes: failing open is how assistants get servers.
  const known = TOOLS.some((tool) => tool.name === name);
  return !known || WRITE_TOOLS.has(name);
}

/** Whether the model must ask before this tool runs: it writes, or it egresses secrets. */
export function needsConfirm(name: string): boolean {
  return isWriteTool(name) || SECRET_TOOLS.has(name);
}

export function findTool(name: string): McpTool | null {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Settings, following the mail-settings precedent exactly.
// ---------------------------------------------------------------------------

export type AssistProvider = 'anthropic' | 'openai' | 'ollama' | 'custom';

const DEFAULT_BASE: Record<AssistProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom: '',
};

const DEFAULT_MODEL: Record<AssistProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  ollama: '',
  custom: '',
};

export interface AssistSettings {
  provider: AssistProvider;
  model: string;
  baseUrl: string;
  /** Whether a key is stored. Never the key itself. */
  hasKey: boolean;
}

export function assistSettings(): AssistSettings {
  const provider = (getSetting(SETTINGS.aiProvider) as AssistProvider) || 'anthropic';
  return {
    provider,
    model: getSetting(SETTINGS.aiModel) || DEFAULT_MODEL[provider],
    baseUrl: getSetting(SETTINGS.aiBaseUrl) || DEFAULT_BASE[provider],
    hasKey: !!getSetting(SETTINGS.aiKey),
  };
}

export function saveAssistSettings(patch: {
  provider?: AssistProvider;
  model?: string;
  baseUrl?: string;
  /** Empty string clears the key; undefined keeps it. */
  key?: string;
}): AssistSettings {
  if (patch.provider) setSetting(SETTINGS.aiProvider, patch.provider);
  if (patch.model !== undefined) setSetting(SETTINGS.aiModel, patch.model.trim());
  if (patch.baseUrl !== undefined) setSetting(SETTINGS.aiBaseUrl, patch.baseUrl.trim());
  if (patch.key !== undefined) {
    if (patch.key.trim() === '') deleteSetting(SETTINGS.aiKey);
    else setSetting(SETTINGS.aiKey, encrypt(patch.key.trim()));
  }
  return assistSettings();
}

export function assistReady(): boolean {
  const settings = assistSettings();
  if (!settings.model) return false;
  // Ollama and self-hosted runners need no key; the paid APIs do.
  if (settings.provider === 'anthropic' || settings.provider === 'openai') {
    return settings.hasKey;
  }
  return true;
}

function providerSettings(): ProviderSettings {
  const settings = assistSettings();
  const dialect: Dialect = settings.provider === 'anthropic' ? 'anthropic' : 'openai';
  const encrypted = getSetting(SETTINGS.aiKey);
  let key: string | null = null;
  if (encrypted) {
    try {
      key = decrypt(encrypted);
    } catch {
      key = null;
    }
  }
  return { dialect, baseUrl: settings.baseUrl, model: settings.model, key };
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the assistant inside a Derailed server's dashboard, version ${VERSION}.
Derailed is a self-hosted platform: projects hold apps and databases, the proxy hands out addresses, backups restore.
You act through tools. Reads run immediately; anything that changes the server is shown to the person first and runs only if they press confirm, so propose one change at a time and say plainly what it will do.
You are speaking to a signed-in person and every tool call runs with their own permissions: if the API refuses, tell them what it said rather than trying another way in.
Answer in plain language, short and concrete. Never invent a status you did not read with a tool.`;

export interface AssistOutcome {
  /** What to append to the transcript: the assistant turns and executed tool results. */
  messages: ChatMessage[];
  /** Set when the model wants a write and a person has to press the button. */
  proposal: { id: string; name: string; args: Record<string, unknown>; what: string } | null;
}

const MAX_TOOL_ROUNDS = 6;

/**
 * One user turn, run to completion or to the first proposed write.
 *
 * `api` is bound to the caller's own session, so every read the model makes is
 * a read that person could have made, refused where they would be refused.
 */
export async function runAssist(transcript: ChatMessage[], api: Api): Promise<AssistOutcome> {
  const appended: ChatMessage[] = [];
  const working = [...transcript];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const answer = await callProvider(providerSettings(), SYSTEM_PROMPT, working, TOOLS);

    const assistant: ChatMessage = {
      role: 'assistant',
      text: answer.text,
      ...(answer.toolCalls.length ? { toolCalls: answer.toolCalls } : {}),
    };
    appended.push(assistant);
    working.push(assistant);

    if (!answer.toolCalls.length) return { messages: appended, proposal: null };

    // Models emit several tool calls in one turn, and every one of them is a
    // tool_use block that the provider will reject on the next round unless it
    // has a matching result. So each call is answered here: the reads by running
    // them, and the gated ones (writes, secret reads) by a placeholder, with the
    // *first* gated call surfaced as the proposal whose real result arrives when
    // the person presses the button.
    const firstGated = answer.toolCalls.find((call) => needsConfirm(call.name));
    let proposal: AssistOutcome['proposal'] = null;

    for (const call of answer.toolCalls) {
      if (needsConfirm(call.name)) {
        if (call === firstGated) {
          proposal = {
            id: call.id,
            name: call.name,
            args: call.args,
            what: describeProposal(call.name, call.args, findTool(call.name)),
          };
          // No result appended for the proposal: the confirm endpoint supplies it.
          continue;
        }
        // A second change in the same turn waits its turn; the transcript still
        // needs a result for its block, so it gets an honest placeholder.
        const placeholder: ChatMessage = {
          role: 'tool',
          id: call.id,
          name: call.name,
          result: 'Not run: review the change above first, then ask again.',
        };
        appended.push(placeholder);
        working.push(placeholder);
        continue;
      }
      const result = await executeTool(call, api);
      appended.push(result);
      working.push(result);
    }

    if (proposal) return { messages: appended, proposal };
  }

  appended.push({
    role: 'assistant',
    text: 'That took more digging than one question should. Ask again more narrowly.',
  });
  return { messages: appended, proposal: null };
}

/**
 * A job or command with no service runs on the *host* as whoever Derailed runs
 * as, root on a real install. The assistant does not get to schedule those,
 * whatever a poisoned log line talked the model into proposing: the blast radius
 * of one misread confirm is the whole machine. The Scheduled tab is where a
 * person does that deliberately.
 */
function isServerLevelJob(call: ToolCall): boolean {
  if (call.name !== 'add_job' && call.name !== 'run_command') return false;
  const service = call.args.service ?? call.args.serviceId ?? call.args.app;
  return typeof service !== 'string' || service.trim() === '';
}

/** The sentence on the confirm card: the generic description, made specific where it counts. */
function describeProposal(
  name: string,
  args: Record<string, unknown>,
  tool: McpTool | null,
): string {
  if ((name === 'add_job' || name === 'run_command') && isServerLevelJob({ id: '', name, args })) {
    return 'This would run on the SERVER ITSELF as root, not inside an app. The assistant is not allowed to do that; use the Scheduled tab if you mean it.';
  }
  if (SECRET_TOOLS.has(name)) {
    return `${tool?.description ?? name} The values are secrets, and running this sends them to your AI provider.`;
  }
  return tool?.description ?? 'Something Derailed does not recognise.';
}

/** Runs one tool as the caller, and answers in the shape the transcript wants. */
export async function executeTool(call: ToolCall, api: Api): Promise<ChatMessage> {
  if (isServerLevelJob(call)) {
    return {
      role: 'tool',
      id: call.id,
      name: call.name,
      result:
        'Refused: the assistant cannot run commands on the server itself. Do it from the Scheduled tab.',
    };
  }
  const tool = findTool(call.name);
  if (!tool) {
    return { role: 'tool', id: call.id, name: call.name, result: 'No such tool.' };
  }
  try {
    const result = await tool.run(api, call.args);
    return {
      role: 'tool',
      id: call.id,
      name: call.name,
      result: JSON.stringify(result ?? { ok: true }).slice(0, 20_000),
    };
  } catch (err) {
    return {
      role: 'tool',
      id: call.id,
      name: call.name,
      result: `Refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
