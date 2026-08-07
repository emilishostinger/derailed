import { Plus, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Spinner, Switch } from './ui.tsx';

type Webhook = Awaited<ReturnType<typeof endpoints.webhooks>>['webhooks'][number];

/**
 * Places this server tells when something happens.
 *
 * Deliberately separate from the alert channels above, which include a webhook of
 * their own. That one posts the prose a person reads in Discord, only fires for the
 * alerts somebody switched on, and says the same problem once. This one is for wiring
 * Derailed into something: every occurrence, a stable event name, and a signature.
 *
 * The page says that difference out loud, because two things called "webhook" on one
 * screen is otherwise a puzzle.
 */
export function Webhooks() {
  const [state, setState] = useState<Awaited<ReturnType<typeof endpoints.webhooks>> | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    endpoints
      .webhooks()
      .then(setState)
      .catch(() => setState({ webhooks: [], kinds: [] }));
  }, []);

  useEffect(load, [load]);

  if (!state) return null;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        Somewhere to POST a small JSON message every time something happens here, for wiring
        Derailed into something of your own. Different from the webhook alert channel above: this
        sends every occurrence rather than a tidied-up one, in a fixed shape, whatever is switched
        on for alerts.
      </p>

      {state.webhooks.length > 0 && (
        <div className="space-y-2">
          {state.webhooks.map((webhook) => (
            <Row
              key={webhook.id}
              webhook={webhook}
              busy={busy}
              onChanged={load}
              setBusy={setBusy}
              setError={setError}
            />
          ))}
        </div>
      )}

      {adding ? (
        <div className="max-w-lg space-y-3 rounded-[var(--radius-card)] border border-line p-3.5">
          <Field label="Where to send it">
            <input
              className="input font-mono text-[13px]"
              value={url}
              placeholder="https://example.com/derailed"
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <Field
            label="Signing secret"
            hint="Optional. When set, each message carries an x-derailed-signature header your end can check, so it knows the message really came from here."
          >
            <input
              className="input font-mono text-[13px]"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !url.trim()}
              onClick={() => {
                setBusy('add');
                setError(null);
                endpoints
                  .addWebhook(url.trim(), secret, null)
                  .then(() => {
                    setUrl('');
                    setSecret('');
                    setAdding(false);
                    load();
                  })
                  .catch(setError)
                  .finally(() => setBusy(null));
              }}
            >
              {busy === 'add' && <Spinner />}
              Add it
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add a webhook
        </button>
      )}

      <ErrorNote error={error} />
    </div>
  );
}

function Row({
  webhook,
  busy,
  onChanged,
  setBusy,
  setError,
}: {
  webhook: Webhook;
  busy: string | null;
  onChanged: () => void;
  setBusy: (value: string | null) => void;
  setError: (value: unknown) => void;
}) {
  const push = useToasts((s) => s.push);

  return (
    <div className="rounded-[var(--radius-card)] border border-line p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] text-ink">{webhook.url}</p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {webhook.hasSecret ? 'Signed' : 'Not signed'}
            {' · '}
            {webhook.events === null ? 'every event' : `${webhook.events.length} events`}
            {/* What happened last time, so nobody has to go and look at the other end
                to find out whether this has ever worked. */}
            {webhook.lastAt !== null && (
              <>
                {' · '}
                {webhook.lastError ? (
                  <span className="text-danger">last try {webhook.lastError}</span>
                ) : (
                  <span className="text-ok">last delivered fine</span>
                )}
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          disabled={busy !== null || !webhook.enabled}
          onClick={() => {
            setBusy(webhook.id);
            setError(null);
            endpoints
              .testWebhook(webhook.id)
              .then(() => push({ message: 'Sent. Check the other end.', tone: 'ok' }))
              .catch(setError)
              // The delivery is on its way rather than done, so the status catches up
              // a moment later. Reloading now would show the previous one.
              .finally(() =>
                setTimeout(() => {
                  setBusy(null);
                  onChanged();
                }, 1200),
              );
          }}
        >
          {busy === webhook.id ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
          Test
        </button>
        <button
          type="button"
          aria-label="Remove this webhook"
          className="btn-ghost shrink-0 px-2 text-ink-faint hover:text-danger"
          disabled={busy !== null}
          onClick={() => {
            setBusy(webhook.id);
            endpoints
              .deleteWebhook(webhook.id)
              .then(onChanged)
              .catch(setError)
              .finally(() => setBusy(null));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2.5 border-t border-line pt-2.5">
        <Switch
          checked={webhook.enabled}
          label="Send to this one"
          disabled={busy !== null}
          onChange={(next) => {
            setBusy(webhook.id);
            setError(null);
            endpoints
              .setWebhookEnabled(webhook.id, next)
              .then(onChanged)
              .catch(setError)
              .finally(() => setBusy(null));
          }}
        />
      </div>
    </div>
  );
}
