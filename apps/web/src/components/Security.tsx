import { KeyRound, Monitor, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { cx, ErrorNote, Field, Spinner } from './ui.tsx';

/**
 * The second factor, and the list of who is signed in.
 *
 * One password guards a machine that can run anything, which made the sign-in screen
 * the weakest sentence in a product whose pitch includes "your data, your machine".
 */
interface SessionRow {
  id: string;
  createdAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

export function Security() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = () => {
    endpoints
      .sessions()
      .then(setSessions)
      .catch(() => undefined);
    endpoints
      .me()
      .then((me) => setEnabled(me.totpEnabled ?? false))
      .catch(() => setEnabled(false));
  };

  // Loaded once on mount. `load` is recreated every render, so it is deliberately
  // not a dependency: including it would refetch on every keystroke in the form.
  useEffect(() => {
    load();
  }, [load]);

  if (enabled === null) return null;

  return (
    <div className="space-y-5">
      <section>
        <p className="eyebrow mb-2">Two-step sign-in</p>

        {enabled ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft p-3.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              <p className="text-[13px] text-ink">
                Signing in asks for a code from your authenticator app as well as your password.
              </p>
            </div>

            <div className="max-w-sm">
              <Field label="Your password, to turn it off">
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </div>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy !== null || !password}
              onClick={async () => {
                setBusy('off');
                setError(null);
                try {
                  await endpoints.disableTotp(password);
                  setEnabled(false);
                  setPassword('');
                  push({ message: 'Two-step sign-in is off.', tone: 'info' });
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'off' && <Spinner />}
              Turn it off
            </button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-muted">
              Open your authenticator app, add an account, and paste this in. Then type the code it
              shows, so we know it works before this is switched on.
            </p>
            <code className="block max-w-sm break-all rounded-[var(--radius-control)] bg-surface-2 p-2.5 text-[12px] text-ink">
              {setup.secret}
            </code>
            <div className="max-w-[10rem]">
              <Field label="The code it shows">
                <input
                  className="input font-mono"
                  inputMode="numeric"
                  value={code}
                  placeholder="123456"
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
            </div>
            <ErrorNote error={error} />
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || code.trim().length < 6}
              onClick={async () => {
                setBusy('confirm');
                setError(null);
                try {
                  const result = await endpoints.confirmTotp(code.trim());
                  setCodes(result.recoveryCodes);
                  setEnabled(true);
                  setSetup(null);
                  setCode('');
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'confirm' && <Spinner />}
              Turn it on
            </button>
          </div>
        ) : (
          <div>
            <p className="mb-2.5 text-[13px] text-ink-muted">
              A code from your phone as well as your password. This dashboard can run anything on
              this machine, so it is worth the extra six seconds.
            </p>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('start');
                setError(null);
                try {
                  setSetup(await endpoints.startTotp());
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'start' ? <Spinner /> : <KeyRound className="h-3.5 w-3.5" />}
              Set it up
            </button>
          </div>
        )}

        {codes && (
          <div className="mt-3 rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft p-3.5">
            <p className="text-[13px] text-ink">
              Write these down now. Each one signs you in once, and this is the only time they are
              shown.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[12px] text-ink-muted sm:grid-cols-3">
              {codes.map((entry) => (
                <span key={entry}>{entry}</span>
              ))}
            </div>
            <button type="button" className="btn-ghost mt-2" onClick={() => setCodes(null)}>
              I have written them down
            </button>
          </div>
        )}

        <ErrorNote error={error} />
      </section>

      <section>
        <p className="eyebrow mb-2">Where you are signed in</p>
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Monitor className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p
                  className={cx(
                    'truncate text-[13px]',
                    session.current ? 'text-ink' : 'text-ink-muted',
                  )}
                >
                  {describe(session.userAgent)}
                  {session.current && <span className="ml-1.5 text-[12px] text-ok">this one</span>}
                </p>
                <p className="text-[12px] text-ink-faint">
                  Since {new Date(session.createdAt).toLocaleString()}
                  {session.ip && ` · ${session.ip}`}
                </p>
              </div>
              {!session.current && (
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  onClick={async () => {
                    await endpoints.endSession(session.id).catch(() => undefined);
                    load();
                  }}
                >
                  Sign it out
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Enough to recognise a device, which is all this is for. */
function describe(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const os = /Android/i.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/i.test(userAgent)
      ? 'iPhone or iPad'
      : /Mac OS X/i.test(userAgent)
        ? 'Mac'
        : /Windows/i.test(userAgent)
          ? 'Windows'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : 'Unknown';
  const browser = /Firefox\//i.test(userAgent)
    ? 'Firefox'
    : /Edg\//i.test(userAgent)
      ? 'Edge'
      : /Chrome\//i.test(userAgent)
        ? 'Chrome'
        : /Safari\//i.test(userAgent)
          ? 'Safari'
          : 'a browser';
  return `${browser} on ${os}`;
}
