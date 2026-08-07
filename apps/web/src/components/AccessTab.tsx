import type { Service } from '@derailed/shared';
import { Ban, Globe, Lock, MapPin, Plus, ShieldCheck, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { cx, ErrorNote, Field, Spinner, Switch } from './ui.tsx';

/**
 * Who is allowed to see this app.
 *
 * All of this is enforced by the proxy rather than by the app, which is what makes it
 * work at all: WordPress, a folder of HTML and something written in a language nobody
 * here has heard of are all covered identically, and none of them has to be changed.
 *
 * The page leads with what is true right now rather than with the controls. Four
 * settings that interact is four things to hold in your head; one sentence saying
 * "anyone can see this" or "only two addresses, and they need a password" is the
 * thing somebody actually opened the tab to find out.
 */
export function AccessTab({ service }: { service: Service }) {
  const access = service.access;
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);

  const [username, setUsername] = useState(access?.username ?? 'visitor');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function save(patch: Parameters<typeof endpoints.setAccess>[1], what: string) {
    setBusy(what);
    setError(null);
    try {
      await endpoints.setAccess(service.id, patch);
      await load();
      return true;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(null);
    }
  }

  const allowFrom = access?.allowFrom ?? [];
  const blockFrom = access?.blockFrom ?? [];

  return (
    <div className="space-y-6">
      <Summary
        maintenance={access?.maintenance ?? false}
        hasPassword={access?.hasPassword ?? false}
        allowCount={allowFrom.length}
        blockCount={blockFrom.length}
      />

      <section>
        <p className="eyebrow mb-2">A password to get in</p>
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
                  void save({ password: null }, 'clear')
                    .then(() => push({ message: 'This site is public again.', tone: 'info' }))
                    .catch(() => undefined);
                }}
              >
                {busy === 'clear' && <Spinner />}
                Stop asking for it
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
                void save({ username, password }, 'set')
                  .then(() => {
                    setPassword('');
                    push({ message: 'Done. Visitors will be asked for it now.', tone: 'ok' });
                  })
                  .catch(() => undefined);
              }}
            >
              {busy === 'set' && <Spinner />}
              Ask for a password
            </button>
          </div>
        )}
      </section>

      <AddressList
        title="Only from these addresses"
        blurb="Everyone else gets a plain refusal, before the password is even asked for. Leave it empty to let the world in."
        empty="Empty, so anyone can reach this."
        icon={<ShieldCheck className="h-3.5 w-3.5 text-ok" />}
        entries={allowFrom}
        busy={busy}
        offerMine
        onChange={(next, force) => save({ allowFrom: next, force }, 'allow')}
      />

      <AddressList
        title="Never from these addresses"
        blurb="One address hammering the login page, or a bot ignoring robots.txt. Checked first, so a block here wins over an invitation above."
        empty="Empty, so nobody is singled out."
        icon={<Ban className="h-3.5 w-3.5 text-danger" />}
        entries={blockFrom}
        busy={busy}
        onChange={(next, force) => save({ blockFrom: next, force }, 'block')}
      />

      <section>
        <p className="eyebrow mb-2">Maintenance</p>
        <Switch
          checked={access?.maintenance ?? false}
          label="Show a holding page instead of the app"
          hint="Visitors get a short 'back shortly' page. The app keeps running, and search engines are told it is temporary. This overrides everything above."
          disabled={busy !== null}
          onChange={(next) => {
            void save({ maintenance: next }, 'maintenance').catch(() => undefined);
          }}
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
 * What is true right now, in one sentence.
 *
 * Four settings that interact is four things to hold in your head, and the reading
 * that matters is the combination. Somebody who has set a password and then, weeks
 * later, an address list, should not have to work out which one is winning.
 */
function Summary({
  maintenance,
  hasPassword,
  allowCount,
  blockCount,
}: {
  maintenance: boolean;
  hasPassword: boolean;
  allowCount: number;
  blockCount: number;
}) {
  const open = !maintenance && !hasPassword && allowCount === 0;

  let sentence: string;
  if (maintenance) {
    sentence = 'Nobody sees the app. Everyone gets the holding page, whatever else is set below.';
  } else {
    const parts: string[] = [];
    if (allowCount > 0) {
      parts.push(`only ${allowCount === 1 ? 'one address' : `${allowCount} addresses`}`);
    }
    if (hasPassword) parts.push('only with the password');
    sentence =
      parts.length === 0
        ? 'Anyone on the internet can see this.'
        : `Visible ${parts.join(', and ')}.`;
    if (blockCount > 0) {
      sentence += ` ${blockCount === 1 ? 'One address is' : `${blockCount} addresses are`} turned away outright.`;
    }
  }

  return (
    <div
      className={cx(
        'flex items-start gap-2.5 rounded-[var(--radius-card)] border p-3.5',
        maintenance
          ? 'border-warn/30 bg-warn-soft'
          : open
            ? 'border-line bg-surface-2'
            : 'border-ok/30 bg-ok-soft',
      )}
    >
      {maintenance ? (
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      ) : open ? (
        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
      )}
      <p className="text-[13px] text-ink">{sentence}</p>
    </div>
  );
}

/**
 * One list of addresses, used for both the invitation and the refusal.
 *
 * The same component for both because they are the same interaction, and two
 * near-identical blocks of markup drift apart the first time one of them is fixed.
 */
function AddressList({
  title,
  blurb,
  empty,
  icon,
  entries,
  busy,
  offerMine,
  onChange,
}: {
  title: string;
  blurb: string;
  empty: string;
  icon: React.ReactNode;
  entries: string[];
  busy: string | null;
  offerMine?: boolean;
  onChange: (next: string[], force?: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [mine, setMine] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState<string[] | null>(null);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    if (!offerMine) return;
    endpoints
      .myAddress()
      .then(setMine)
      .catch(() => undefined);
  }, [offerMine]);

  /**
   * The server refuses once if a block would lock you out, and accepts on the second
   * press. So a refusal is remembered here rather than shown and forgotten: pressing
   * Add again is the confirmation, which is what the message told you to do.
   */
  const commit = (next: string[]) => {
    const force = needsForce !== null && sameList(needsForce, next);
    onChange(next, force || undefined)
      .then(() => {
        setDraft('');
        setNeedsForce(null);
      })
      .catch((err) => {
        setNeedsForce(err instanceof ApiError && /would block you/.test(err.message) ? next : null);
      });
  };

  const add = (value: string) => {
    const entry = value.trim();
    if (!entry) return;
    if (entries.includes(entry)) {
      push({ message: `${entry} is already on the list.`, tone: 'info' });
      setDraft('');
      return;
    }
    commit([...entries, entry]);
  };

  return (
    <section>
      <p className="eyebrow mb-2">{title}</p>
      <p className="mb-2.5 max-w-prose text-[13px] text-ink-muted">{blurb}</p>

      {entries.length === 0 ? (
        <p className="mb-2.5 text-[13px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="mb-2.5 flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <li
              key={entry}
              className="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line py-1 pr-1 pl-2 font-mono text-[12px] text-ink"
            >
              {icon}
              {entry}
              {entry === mine && <span className="font-sans text-ink-faint">you</span>}
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                className="rounded-[4px] p-0.5 text-ink-faint hover:bg-surface-2 hover:text-danger"
                disabled={busy !== null}
                onClick={() => commit(entries.filter((item) => item !== entry))}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex max-w-md flex-wrap gap-2">
        <input
          className="input min-w-48 flex-1 font-mono text-[13px]"
          value={draft}
          placeholder="203.0.113.7, or 203.0.113.0/24"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add(draft)}
        />
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={busy !== null || !draft.trim()}
          onClick={() => add(draft)}
        >
          {busy !== null ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
          {needsForce ? 'Add it anyway' : 'Add'}
        </button>
        {offerMine && mine && !entries.includes(mine) && (
          <button
            type="button"
            className="btn-ghost shrink-0"
            disabled={busy !== null}
            onClick={() => add(mine)}
          >
            <MapPin className="h-3.5 w-3.5" />
            Add mine ({mine})
          </button>
        )}
      </div>
    </section>
  );
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
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
