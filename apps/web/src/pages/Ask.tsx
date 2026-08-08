import { Play, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { ErrorNote, Field, Select, Spinner } from '../components/ui.tsx';
import { useSession } from '../stores/session.ts';
import { PageHeader } from './Layout.tsx';

/**
 * Ask your server.
 *
 * A chat box driving the same tools coding agents already use, with the
 * person's own key or their own Ollama behind it. Reads run as the person
 * asking; anything that would change the server is a card with the exact
 * action on it and a button, which is the entire difference between an
 * assistant and an incident.
 */

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; id: string; name: string; result: string };

interface Proposal {
  id: string;
  name: string;
  args: Record<string, unknown>;
  what: string;
}

interface AssistSettings {
  provider: 'anthropic' | 'openai' | 'ollama' | 'custom';
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

const assist = {
  settings: () => api.get<AssistSettings>('/assist/settings'),
  saveSettings: (patch: Partial<AssistSettings> & { key?: string }) =>
    api.put<AssistSettings>('/assist/settings', patch),
  ask: (messages: Message[]) =>
    api.post<{ messages: Message[]; proposal: Proposal | null }>('/assist', { messages }),
  execute: (proposal: Proposal) => api.post<{ message: Message }>('/assist/execute', proposal),
};

export function Ask() {
  const user = useSession((s) => s.user);
  const [settings, setSettings] = useState<AssistSettings | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    assist.settings().then(setSettings).catch(setError);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  });

  const ready =
    settings && (settings.hasKey || !['anthropic', 'openai'].includes(settings.provider));

  async function send(next: Message[]) {
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      const answer = await assist.ask(next);
      setMessages([...next, ...answer.messages]);
      setProposal(answer.proposal);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(run: boolean) {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      const result: Message = run
        ? (await assist.execute(proposal)).message
        : {
            role: 'tool',
            id: proposal.id,
            name: proposal.name,
            result: 'The person looked at this action and decided not to run it.',
          };
      setProposal(null);
      await send([...messages, result]);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Ask"
        subtitle="Your server, in plain language. Changes wait for your press."
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-3 p-5">
            {user?.role === 'owner' && settings && !ready && (
              <AskSettings settings={settings} onSaved={setSettings} />
            )}
            {settings && !ready && user?.role !== 'owner' && (
              <p className="text-[13px] text-ink-muted">
                Nothing is set up to think with yet. An owner can add an AI key, or point Derailed
                at an Ollama, right here.
              </p>
            )}

            {messages.length === 0 && ready && (
              <div className="rounded-[var(--radius-card)] border border-line bg-sunken px-4 py-3 text-[13px] text-ink-muted">
                Try: <i>why is the blog slow</i> · <i>restart the api</i> ·{' '}
                <i>what broke overnight</i> · <i>back up the shop project</i>
              </div>
            )}

            {messages.map((message, index) => {
              // The transcript is append-only and never reorders, so a position
              // is a stable identity here; role added for readability.
              const key = `${index}-${message.role}`;
              if (message.role === 'user') {
                return (
                  <p
                    key={key}
                    className="ml-auto w-fit max-w-[85%] rounded-[var(--radius-card)] bg-accent-soft px-3.5 py-2 text-[13px] text-ink"
                  >
                    {message.text}
                  </p>
                );
              }
              if (message.role === 'assistant') {
                if (!message.text) return null;
                return (
                  <div
                    key={key}
                    className="w-fit max-w-[85%] rounded-[var(--radius-card)] border border-line px-3.5 py-2 text-[13px] whitespace-pre-wrap text-ink"
                  >
                    {message.text}
                  </div>
                );
              }
              return (
                <p key={key} className="text-[11px] text-ink-faint">
                  {message.name} · {message.result.length > 120 ? 'done' : message.result}
                </p>
              );
            })}

            {proposal && (
              <div className="rounded-[var(--radius-card)] border border-accent bg-accent-soft/50 p-4">
                <p className="text-[13px] font-semibold text-ink">
                  The assistant wants to run: {proposal.name.replaceAll('_', ' ')}
                </p>
                <p className="mt-1 text-[12px] text-ink-muted">{proposal.what}</p>
                {Object.keys(proposal.args).length > 0 && (
                  <pre className="mt-2 overflow-x-auto rounded bg-sunken p-2 text-[11px] text-ink-muted">
                    {JSON.stringify(proposal.args, null, 2)}
                  </pre>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => void confirm(true)}
                  >
                    {busy ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                    Run it
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => void confirm(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                    Not that
                  </button>
                </div>
              </div>
            )}

            {busy && !proposal && <Spinner />}
            <ErrorNote error={error} />
            <div ref={bottom} />
          </div>
        </div>

        <form
          className="border-t border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || busy || !ready) return;
            setDraft('');
            void send([...messages, { role: 'user', text }]);
          }}
        >
          <div className="mx-auto flex max-w-2xl gap-2">
            <input
              className="input flex-1"
              placeholder={ready ? 'Ask your server anything…' : 'Set up a model first'}
              value={draft}
              disabled={!ready || busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={!ready || busy || !draft.trim()}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

/** The one-time setup: whose brain, which model, and the key that stays here. */
function AskSettings({
  settings,
  onSaved,
}: {
  settings: AssistSettings;
  onSaved: (next: AssistSettings) => void;
}) {
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-4">
      <p className="text-[13px] text-ink-muted">
        The assistant runs on a key of your own, or an Ollama on this very box. The key is encrypted
        here and never leaves for anywhere except the address below. Every change it proposes waits
        for a press.
      </p>
      <Select
        ariaLabel="Provider"
        value={provider}
        options={[
          { value: 'anthropic', label: 'Anthropic (Claude)' },
          { value: 'openai', label: 'OpenAI' },
          { value: 'ollama', label: 'Ollama on this server' },
          { value: 'custom', label: 'Something else OpenAI-compatible' },
        ]}
        onChange={(value) => setProvider(value as AssistSettings['provider'])}
      />
      <Field label="Model">
        <input
          className="input"
          value={model}
          placeholder={provider === 'ollama' ? 'llama3.3' : ''}
          onChange={(event) => setModel(event.target.value)}
        />
      </Field>
      {(provider === 'ollama' || provider === 'custom') && (
        <Field label="Address">
          <input
            className="input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
      )}
      {(provider === 'anthropic' || provider === 'openai') && (
        <Field label="API key" hint="Stored encrypted, never shown again.">
          <input
            className="input"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
      )}
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          assist
            .saveSettings({ provider, model, baseUrl, ...(key ? { key } : {}) })
            .then(onSaved)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy && <Spinner />}
        Save
      </button>
      <ErrorNote error={error} />
    </div>
  );
}
