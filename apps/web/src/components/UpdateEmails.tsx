import { Check, Mail, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints, type MailSettings } from '../api/endpoints.ts';
import { cx, ErrorNote, Field, Spinner, Switch } from './ui.tsx';

/**
 * Emailing you when updates are waiting.
 *
 * The dashboard already shows what is pending, which helps exactly as much as you
 * open it. A security update that has been sitting there for six weeks is the normal
 * outcome of a self-hosted server, and the only thing that reliably changes it is
 * something arriving where you already look.
 */
const SECURITY: { value: MailSettings['security']; label: string; port: number }[] = [
  { value: 'starttls', label: 'STARTTLS', port: 587 },
  { value: 'tls', label: 'TLS', port: 465 },
  { value: 'none', label: 'None', port: 25 },
];

export function UpdateEmails() {
  const [mail, setMail] = useState<MailSettings | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .mail()
      .then(setMail)
      .catch(() => undefined);
  }, []);

  if (!mail) {
    return (
      <div className="flex justify-center py-6 text-ink-faint">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  const set = (patch: Partial<MailSettings>) => {
    setMail({ ...mail, ...patch });
    setSaved(false);
    setSent(null);
  };

  async function save() {
    if (!mail) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const next = await endpoints.saveMail({
        host: mail.host,
        port: mail.port,
        security: mail.security,
        username: mail.username,
        // Only sent when it was actually typed into, or an untouched field would
        // clear the password that is already stored.
        ...(password ? { password } : {}),
        from: mail.from,
        fromName: mail.fromName,
        notifyUpdates: mail.notifyUpdates,
        notifyTo: mail.notifyTo,
        securityOnly: mail.securityOnly,
      });
      setMail(next);
      setPassword('');
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!mail) return;
    setSending(true);
    setError(null);
    setSent(null);
    try {
      const result = await endpoints.testMail(mail.notifyTo || mail.from);
      setSent(result.to);
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-5">
      <Switch
        label="Email me when updates are waiting"
        checked={mail.notifyUpdates}
        onChange={(notifyUpdates) => set({ notifyUpdates })}
        hint="Sent when the list of pending updates changes, and never more than once a day. The dashboard shows the same thing, but only when you open it."
      />

      {mail.notifyUpdates && (
        <div className="space-y-4 border-t border-line pt-5">
          <Switch
            label="Only for security updates"
            checked={mail.securityOnly}
            onChange={(securityOnly) => set({ securityOnly })}
            hint="Ordinary version bumps stay in the dashboard."
          />

          <Field label="Send notices to">
            <input
              className="input"
              type="email"
              placeholder="you@example.com"
              value={mail.notifyTo}
              onChange={(event) => set({ notifyTo: event.target.value })}
            />
          </Field>

          <div className="border-t border-line pt-4">
            <p className="eyebrow mb-3 text-ink-faint">Sending through</p>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Mail server">
                <input
                  className="input"
                  placeholder="smtp.example.com"
                  value={mail.host}
                  onChange={(event) => set({ host: event.target.value })}
                />
              </Field>
              <Field label="Port">
                <input
                  className="input w-24 tabular"
                  inputMode="numeric"
                  value={String(mail.port)}
                  onChange={(event) => set({ port: Number(event.target.value) || 0 })}
                />
              </Field>
            </div>

            <div className="mt-3">
              <span className="label">Encryption</span>
              <div className="mt-1 flex gap-1.5">
                {SECURITY.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    // The port almost always follows from this choice, and getting
                    // them out of step is the single most common way this is set up
                    // wrongly. Moving it is easier to correct than to diagnose.
                    onClick={() => set({ security: option.value, port: option.port })}
                    className={cx(
                      'rounded-[var(--radius-control)] border px-3 py-1.5 text-[13px] transition-colors',
                      mail.security === option.value
                        ? 'border-accent bg-accent-soft text-ink'
                        : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Username">
                <input
                  className="input"
                  autoComplete="off"
                  value={mail.username}
                  onChange={(event) => set({ username: event.target.value })}
                />
              </Field>
              <Field
                label="Password"
                hint={
                  mail.hasPassword && !password ? 'One is saved. Type to replace it.' : undefined
                }
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={mail.hasPassword ? '••••••••' : ''}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setSaved(false);
                  }}
                />
              </Field>
            </div>

            {/* Said where the choice was made, not buried in an error afterwards.
                "None" plus a password means the password crosses the network in the
                clear, which is fine to a mail server on this same machine and not
                fine to one anywhere else. */}
            {mail.security === 'none' && (mail.username || password || mail.hasPassword) && (
              <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft px-3 py-2.5 text-[12.5px] text-ink">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                <span>
                  With no encryption, this username and password cross the network in the clear,
                  readable by anything in between. That is fine for a mail server on this machine,
                  and not for one anywhere else.
                </span>
              </p>
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="From address">
                <input
                  className="input"
                  type="email"
                  placeholder="derailed@example.com"
                  value={mail.from}
                  onChange={(event) => set({ from: event.target.value })}
                />
              </Field>
              <Field label="From name">
                <input
                  className="input"
                  value={mail.fromName}
                  onChange={(event) => set({ fromName: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy && <Spinner />}
          Save
        </button>

        {mail.notifyUpdates && (
          <button
            type="button"
            className="btn-secondary"
            disabled={sending || !mail.host.trim()}
            onClick={() => void test()}
          >
            {sending ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
            Send a test
          </button>
        )}

        {saved && (
          <span className="flex items-center gap-1.5 text-[12px] text-ok">
            <Check className="h-3.5 w-3.5" />
            Saved
          </span>
        )}
        {sent && (
          <span className="flex items-center gap-1.5 text-[12px] text-ok">
            <Mail className="h-3.5 w-3.5" />
            Sent to {sent}
          </span>
        )}
      </div>

      {mail.lastSentAt && (
        <p className="text-[12px] text-ink-faint">
          Last notice sent {new Date(mail.lastSentAt).toLocaleString()}.
        </p>
      )}

      <ErrorNote error={error} />
    </div>
  );
}
