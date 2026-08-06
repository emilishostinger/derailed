import type {
  AlertChannel,
  AlertChannelKind,
  AlertEventKind,
  AlertSettings,
} from '@derailed/shared';
import { Bell, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Spinner, Switch } from './ui.tsx';

/**
 * Being told when something goes wrong.
 *
 * The whole anxiety of running your own server is "what if it falls over and I do not
 * find out". This is the answer, and the list of destinations is deliberately the
 * places people actually are rather than the places that are easiest to integrate.
 */
const KINDS: { kind: AlertChannelKind; label: string; hint: string; placeholder: string }[] = [
  {
    kind: 'ntfy',
    label: 'My phone',
    hint: 'Install the free ntfy app, subscribe to a topic nobody could guess, and paste its address here. No account needed anywhere.',
    placeholder: 'https://ntfy.sh/my-server-a7f2xk',
  },
  {
    kind: 'discord',
    label: 'Discord',
    hint: 'Server Settings, Integrations, Webhooks, New Webhook, then Copy Webhook URL.',
    placeholder: 'https://discord.com/api/webhooks/…',
  },
  {
    kind: 'slack',
    label: 'Slack',
    hint: 'An Incoming Webhook URL from your Slack app.',
    placeholder: 'https://hooks.slack.com/services/…',
  },
  {
    kind: 'email',
    label: 'Email',
    hint: 'Uses whatever is set up under Update emails.',
    placeholder: 'you@example.com',
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    hint: 'Your chat id, plus the token @BotFather gave you.',
    placeholder: '123456789',
  },
  {
    kind: 'webhook',
    label: 'Anything else',
    hint: 'Derailed posts JSON to this address.',
    placeholder: 'https://example.com/hook',
  },
];

export function Alerts() {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [kinds, setKinds] = useState<{ kind: AlertEventKind; label: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<AlertChannelKind | null>(null);
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .alerts()
      .then((result) => {
        setSettings(result.settings);
        setKinds(result.kinds);
      })
      .catch(() => undefined);
  }, []);

  if (!settings) return null;

  async function withBusy(what: string, run: () => Promise<void>) {
    setBusy(what);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const add = () =>
    withBusy('add', async () => {
      if (!adding || !target.trim()) return;
      const channel: AlertChannel = {
        id: `${adding}-${Date.now().toString(36)}`,
        kind: adding,
        target: target.trim(),
        secret: secret.trim() || null,
      };
      setSettings(await endpoints.saveAlertChannels([...(settings?.channels ?? []), channel]));
      setAdding(null);
      setTarget('');
      setSecret('');
    });

  const remove = (id: string) =>
    withBusy(id, async () => {
      setSettings(
        await endpoints.saveAlertChannels(
          (settings?.channels ?? []).filter((channel) => channel.id !== id),
        ),
      );
    });

  const test = (id: string) =>
    withBusy(`test-${id}`, async () => {
      await endpoints.testAlertChannel(id);
      push({ message: 'Sent. If it does not turn up, the address is wrong.', tone: 'ok' });
    });

  const toggleEvent = (kind: AlertEventKind, on: boolean) =>
    withBusy(kind, async () => {
      const events = on
        ? [...(settings?.events ?? []), kind]
        : (settings?.events ?? []).filter((event) => event !== kind);
      setSettings(await endpoints.saveAlertEvents(events));
    });

  const chosen = KINDS.find((entry) => entry.kind === adding);

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        Derailed can tell you when something falls over. Every message says what happened and what
        to do about it, and the same problem is never reported twice in a row.
      </p>

      {settings.channels.length > 0 && (
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {settings.channels.map((channel) => (
            <li key={channel.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Bell className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">
                  {KINDS.find((entry) => entry.kind === channel.kind)?.label ?? channel.kind}
                </p>
                <p className="truncate text-[12px] text-ink-faint">{channel.target}</p>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0"
                disabled={busy !== null}
                onClick={() => void test(channel.id)}
              >
                {busy === `test-${channel.id}` && <Spinner />}
                Test
              </button>
              <button
                type="button"
                aria-label="Remove"
                className="shrink-0 text-ink-faint hover:text-danger"
                disabled={busy !== null}
                onClick={() => void remove(channel.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding === null ? (
        <div className="flex flex-wrap gap-2">
          {KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="btn-secondary"
              onClick={() => setAdding(entry.kind)}
            >
              <Plus className="h-3.5 w-3.5" />
              {entry.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-3.5">
          <div className="max-w-md space-y-3">
            <Field label={chosen?.label ?? ''} hint={chosen?.hint}>
              <input
                className="input"
                value={target}
                placeholder={chosen?.placeholder}
                onChange={(event) => setTarget(event.target.value)}
              />
            </Field>
            {adding === 'telegram' && (
              <Field label="Bot token">
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !target.trim()}
              onClick={() => void add()}
            >
              {busy === 'add' && <Spinner />}
              Add it
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <ErrorNote error={error} />

      {settings.channels.length > 0 && kinds.length > 0 && (
        <div className="space-y-2.5 border-t border-line pt-4">
          <p className="eyebrow">Tell me when</p>
          {kinds.map((entry) => (
            <Switch
              key={entry.kind}
              label={entry.label}
              checked={settings.events.includes(entry.kind)}
              disabled={busy !== null}
              onChange={(next) => void toggleEvent(entry.kind, next)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
