import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useSession } from '../stores/session.ts';
import { cx, EmptyState, ErrorNote, Spinner } from './ui.tsx';

interface Token {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Tokens let a coding agent drive this server. Shown once on creation and stored only
 * as a hash, so there is no way to recover one later.
 */
export function ApiTokens() {
  const panelUrl = usePanelUrl();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setTokens(await endpoints.tokens().catch(() => []));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded once; refresh is recreated every render.
  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { secret } = await endpoints.createToken(name.trim() || 'Coding agent');
      setFresh(secret);
      setName('');
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const config = JSON.stringify(
    {
      mcpServers: {
        derailed: {
          command: 'derailed',
          args: ['mcp'],
          env: { DERAILED_URL: panelUrl, DERAILED_TOKEN: fresh ?? 'your-token-here' },
        },
      },
    },
    null,
    2,
  );

  // Nothing made yet. An empty page whose only content is a text box reads as a form
  // you have to fill in before anything will happen, and this one never did: the name
  // is optional and always was. So the first token is one button and no decisions.
  if (tokens.length === 0 && !fresh) {
    return (
      <>
        {error != null && (
          <div className="mx-auto max-w-3xl px-5 pt-5">
            <ErrorNote error={error} />
          </div>
        )}
        <EmptyState
          icon={<KeyRound className="h-5 w-5" />}
          title="No tokens yet"
          body="A token lets a coding agent such as Claude Code, Cursor or Codex deploy apps, read logs and add domains for you, from the editor you are already in."
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? <Spinner /> : <KeyRound className="h-3.5 w-3.5" />}
              Create a token
            </button>
          }
          note="You get the token and the settings to paste into your agent. It is shown once."
        />
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-5">
      <p className="text-[13px] text-ink-muted">
        Derailed comes with an MCP server, so a coding agent such as Claude Code, Cursor or Codex
        can deploy apps, read logs and add domains for you while you work. Create a token, paste the
        block below into the agent, and it is connected.
      </p>

      {fresh && (
        <div className="rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft p-4">
          <p className="text-[13px] font-medium text-ink">Copy this now. It is not shown again.</p>
          <code className="mt-2 block truncate rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink">
            {fresh}
          </code>
          <p className="eyebrow mt-4 mb-1.5">MCP settings for your agent</p>
          <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
            {config}
          </pre>
          <button
            type="button"
            className="btn-secondary mt-2"
            onClick={() => {
              void navigator.clipboard.writeText(config);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy the configuration'}
          </button>
        </div>
      )}

      {tokens.length > 0 && (
        <div className="space-y-1.5">
          {tokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2"
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{token.name}</span>
              <span
                className={cx(
                  'shrink-0 text-[11px]',
                  token.lastUsedAt ? 'text-ok' : 'text-ink-faint',
                )}
              >
                {token.lastUsedAt
                  ? `used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                  : 'never used'}
              </span>
              <button
                type="button"
                className="btn-ghost px-1.5 text-danger"
                title="Revoke"
                onClick={async () => {
                  await endpoints.deleteToken(token.id).catch(() => undefined);
                  await refresh();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Only once there is a list to tell apart is a name worth asking for, and even
          then it is optional: left blank it is simply "Coding agent". */}
      <div className="flex gap-2 border-t border-line pt-5">
        <input
          className="input"
          placeholder="Name this one (optional)"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void create()}
        />
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={busy}
          onClick={() => void create()}
        >
          {busy ? <Spinner /> : <KeyRound className="h-3.5 w-3.5" />}
          Create another
        </button>
      </div>

      <ErrorNote error={error} />
    </div>
  );
}

/** The address the agent should talk to, which is the one you are reading this on. */
function usePanelUrl(): string {
  const ip = useSession((s) => s.system?.serverIp);
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    return window.location.origin;
  }
  return ip ? `http://${ip}:8422` : 'http://your-server:8422';
}
