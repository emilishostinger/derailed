import type { Service } from '@derailed/shared';
import { Lock, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Spinner, Switch } from './ui.tsx';

/**
 * Who is allowed to see this app.
 *
 * All three of these are enforced by the proxy rather than by the app, which is what
 * makes them work at all: WordPress, a folder of HTML and something written in a
 * language nobody here has heard of are all covered identically, and none of them has
 * to be changed.
 *
 * The password is the one that unlocks the most. Every staging site, every internal
 * tool and every "not ready yet" project needs exactly this and nothing more.
 */
export function AccessTab({ service }: { service: Service }) {
  const access = service.access;
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);

  const [username, setUsername] = useState(access?.username ?? 'visitor');
  const [password, setPassword] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function save(patch: Parameters<typeof endpoints.setAccess>[1], what: string) {
    setBusy(what);
    setError(null);
    try {
      await endpoints.setAccess(service.id, patch);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const allowFrom = access?.allowFrom ?? [];

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow mb-2">Who can see it</p>
        {access?.hasPassword ? (
          <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft p-3.5">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink">
                Visitors are asked for a password. The username is{' '}
                <span className="text-ink-muted">{access.username}</span>.
              </p>
              <button
                type="button"
                className="btn-ghost mt-2"
                disabled={busy !== null}
                onClick={() => {
                  void save({ password: null }, 'clear').then(() =>
                    push({ message: 'This site is public again.', tone: 'info' }),
                  );
                }}
              >
                {busy === 'clear' && <Spinner />}
                Make it public again
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-sm space-y-3">
            <p className="text-[13px] text-ink-muted">
              Ask everyone for a password before they see anything. The browser does the asking, so
              this works whatever the app is.
            </p>
            <Field label="Username">
              <input
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field label="Password" hint="At least six characters.">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || password.length < 6}
              onClick={() => {
                void save({ username, password }, 'set').then(() => {
                  setPassword('');
                  push({ message: 'Done. Visitors will be asked for it now.', tone: 'ok' });
                });
              }}
            >
              {busy === 'set' && <Spinner />}
              Ask for a password
            </button>
          </div>
        )}
      </section>

      <section>
        <p className="eyebrow mb-2">Only from certain addresses</p>
        <p className="mb-2.5 text-[13px] text-ink-muted">
          Anyone else gets a plain refusal, before the password is even asked for. Leave empty to
          let everyone in.
        </p>

        {allowFrom.length > 0 && (
          <ul className="mb-2.5 flex flex-wrap gap-1.5">
            {allowFrom.map((entry) => (
              <li
                key={entry}
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line px-2 py-1 text-[12px] text-ink"
              >
                {entry}
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  className="text-ink-faint hover:text-danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void save(
                      { allowFrom: allowFrom.filter((item) => item !== entry) },
                      `rm-${entry}`,
                    )
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex max-w-sm gap-2">
          <input
            className="input"
            value={address}
            placeholder="203.0.113.7, or 203.0.113.0/24"
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary shrink-0"
            disabled={busy !== null || !address.trim()}
            onClick={() =>
              void save({ allowFrom: [...allowFrom, address.trim()] }, 'add').then(() =>
                setAddress(''),
              )
            }
          >
            {busy === 'add' ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </button>
        </div>
      </section>

      <section>
        <p className="eyebrow mb-2">Maintenance</p>
        <Switch
          checked={access?.maintenance ?? false}
          label="Show a holding page instead of the app"
          hint="Visitors get a short 'back shortly' page. The app keeps running, and search engines are told it is temporary."
          disabled={busy !== null}
          onChange={(next) => void save({ maintenance: next }, 'maintenance')}
        />
      </section>

      <section className="border-t border-line pt-4">
        <p className="eyebrow mb-2">Sending email</p>
        <AppMail service={service} />
      </section>

      <ErrorNote error={error} />
    </div>
  );
}

/**
 * Letting an app send email with whatever Derailed sends its own with.
 *
 * The number one "I installed it and it half works" complaint in self-hosting:
 * WordPress password resets, Gitea invitations, Vaultwarden verification, all of
 * which need an SMTP server nobody has.
 */
function AppMail({ service }: { service: Service }) {
  const [state, setState] = useState<{ enabled: boolean; available: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .appMail(service.id)
      .then(setState)
      .catch(() => undefined);
  }, [service.id]);

  if (!state) return null;

  if (!state.available && !state.enabled) {
    return (
      <p className="text-[13px] text-ink-faint">
        Derailed has nothing to send email with yet. Set up a mail provider under Settings, and this
        app can borrow it.
      </p>
    );
  }

  return (
    <div>
      <Switch
        checked={state.enabled}
        label="Let this app send email"
        hint="Adds the usual SMTP variables, using the same provider Derailed sends its own notifications through. They appear on the Variables tab like anything else."
        disabled={busy}
        onChange={async (next) => {
          setBusy(true);
          setError(null);
          try {
            await endpoints.setAppMail(service.id, next);
            setState({ ...state, enabled: next });
            push({
              message: next
                ? 'Done. Redeploy the app for it to pick them up.'
                : 'Removed. Redeploy the app to stop using them.',
              tone: 'ok',
            });
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
      <ErrorNote error={error} />
    </div>
  );
}
