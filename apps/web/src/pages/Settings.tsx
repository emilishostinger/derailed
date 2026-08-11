import type { UserRole } from '@derailed/shared';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { Alerts } from '../components/Alerts.tsx';
import {
  confettiEnabled,
  playChime,
  setConfettiEnabled,
  setSoundsEnabled,
  soundsEnabled,
} from '../components/Celebrate.tsx';
import { MoveServer } from '../components/MoveServer.tsx';
import { People } from '../components/People.tsx';
import { Security } from '../components/Security.tsx';
import { Tailscale } from '../components/Tailscale.tsx';
import { UpdateEmails } from '../components/UpdateEmails.tsx';
import { ErrorNote, Field, Spinner, Switch } from '../components/ui.tsx';
import { Webhooks } from '../components/Webhooks.tsx';
import { useSession } from '../stores/session.ts';
import { PageHeader } from './Layout.tsx';

/** Said in the account panel, so nobody has to guess why a button is missing. */
const ROLE_SUMMARY: Record<UserRole, string> = {
  owner: 'You own this server, so you can change anything on it.',
  member:
    'You can run the apps here: deploy them, read their logs, change their variables. Deleting them, and changing the server itself, is for an owner.',
  viewer: 'You can look at everything here, and change nothing.',
};

export function Settings() {
  const user = useSession((s) => s.user);
  const isOwner = user?.role === 'owner';
  const system = useSession((s) => s.system);
  const setSystem = useSession((s) => s.setSystem);
  const [ip, setIp] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIp(system?.serverIp ?? '');
  }, [system?.serverIp]);

  async function save(value: string | null) {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const { system: updated } = await api.patchSystem(value);
      setSystem(updated);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-5">
          <Section title="Account">
            <p className="text-[13px] text-ink">{user?.email}</p>
            {user && <p className="mt-1 text-[12px] text-ink-faint">{ROLE_SUMMARY[user.role]}</p>}
            <p className="mt-2 text-[12px] text-ink-faint">
              To change the password, run{' '}
              <code className="text-ink-muted">derailed reset-password</code> on the server.
            </p>
          </Section>

          <Section title="Signing in">
            <Security />
          </Section>

          {isOwner && (
            <Section title="Who else can get in">
              <People />
            </Section>
          )}

          {/* Everything below this line is about the server rather than about you, so
              it is an owner's to change. Hidden rather than shown-and-refused: a
              screen full of controls that answer "you cannot do that" is a worse
              explanation than a screen that only offers what is yours. */}
          {isOwner && (
            <>
              <Section title="Domains and the padlock">
                <p className="text-[13px] text-ink-muted">
                  The dashboard's address, the free secure address, and the domain your apps live
                  under all moved to the Domains page, where the rest of the domain work happens.
                </p>
                <RouterLink to="/domains" className="btn-secondary mt-3 inline-flex">
                  Open Domains
                </RouterLink>
              </Section>

              <Section title="How your apps look, and sound">
                <Screenshots />
              </Section>

              <Section title="Tell me when something breaks">
                <Alerts />
              </Section>

              <Section title="Tell something else when it happens">
                <Webhooks />
              </Section>

              <Section title="Keeping up to date">
                <UpdateCheck />
              </Section>

              <Section title="Update emails">
                <UpdateEmails />
              </Section>

              <Section title="Reach this server from anywhere">
                <Tailscale />
              </Section>

              <Section title="Moving to another server">
                <MoveServer />
              </Section>
            </>
          )}

          {/* Owner-only for the same reason as the block above: this is the machine's
              own address, not a preference. */}
          {isOwner && (
            <>
              {/* This was behind a disclosure marked "Advanced", which held one field and
              drew the browser's own triangle in a page where nothing else has one. A
              heading with one thing under it does not need a lid, and "Advanced" was
              telling people to be nervous about a box they will never open. The
              hint already says nobody needs to touch it. */}
              <Section title="Public address">
                <div className="max-w-sm">
                  <Field
                    label="This server's address on the internet"
                    hint="Derailed works this out by itself and almost nobody needs to change it. Set it only if your server sits behind a different address, such as a load balancer."
                  >
                    <input
                      className="input"
                      value={ip}
                      onChange={(e) => setIp(e.target.value)}
                      placeholder="203.0.113.7"
                    />
                  </Field>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => void save(ip.trim())}
                  >
                    {busy && <Spinner />}
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => void save(null)}
                  >
                    Work it out again
                  </button>
                  {saved && <span className="text-[12px] text-ok">Saved</span>}
                </div>
                <div className="mt-3">
                  <ErrorNote error={error} />
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Whether to photograph the running sites.
 *
 * On by default, off in one press, and the hint says what the first capture
 * costs: a browser image of a few hundred megabytes, downloaded once.
 */
function Screenshots() {
  const [on, setOn] = useState<boolean | null>(null);
  const [sounds, setSounds] = useState(soundsEnabled);
  const [confetti, setConfetti] = useState(confettiEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .previewSettings()
      .then(setOn)
      .catch(() => setOn(false));
  }, []);

  if (on === null) return null;

  return (
    <div>
      <p className="mb-3 text-[13px] text-ink-muted">
        Every app already shows its own icon and title on the dashboard, taken from the running
        site. Derailed can also take a picture of each one every few hours.
      </p>
      <Switch
        checked={on}
        label="Take screenshots of my sites"
        hint="On unless you turn it off. Needs a browser on the server, about 300 MB, downloaded once the first time a picture is taken. Turn off on a small disk."
        onChange={async (next) => {
          setBusy(true);
          setError(null);
          try {
            setOn(await endpoints.setPreviewSettings(next));
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
      />
      <ErrorNote error={error} />

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <Switch
          checked={confetti}
          label="Throw confetti when a deploy works"
          hint="A deploy working is the good part of this. Kept in this browser, and it stays out of the way if your system asks for reduced motion."
          onChange={(next) => {
            setConfettiEnabled(next);
            setConfetti(next);
          }}
        />
        <Switch
          checked={sounds}
          label="Make a sound when a deploy finishes"
          hint="Kept in this browser, not on the server: whether your laptop makes a noise is about the room you are in."
          onChange={(next) => {
            setSoundsEnabled(next);
            setSounds(next);
            if (next) playChime('ok');
          }}
        />
      </div>
    </div>
  );
}

/**
 * Explicit, never automatic. Derailed doesn't phone home in the background, and
 * this is the only thing that talks to GitHub.
 */
function UpdateCheck() {
  const [state, setState] = useState<'idle' | 'checking' | 'done' | 'failed'>('idle');
  const [result, setResult] = useState<Awaited<ReturnType<typeof endpoints.checkUpdate>>>(null);
  const [flow, setFlow] = useState<'none' | 'updating' | 'restarting' | 'back' | 'stuck'>('none');
  const [flowLog, setFlowLog] = useState<string[]>([]);
  const [flowError, setFlowError] = useState<unknown>(null);

  async function check() {
    setState('checking');
    try {
      const update = await endpoints.checkUpdate();
      setResult(update);
      setState(update ? 'done' : 'failed');
    } catch {
      setState('failed');
    }
  }

  /**
   * The whole rollout from one button: install the new binary, ask Derailed to
   * restart itself, then knock every couple of seconds until a different
   * version answers, and reload the page into it. Apps keep running throughout;
   * only the dashboard blinks.
   */
  async function updateAndRestart() {
    setFlowError(null);
    setFlowLog([]);
    setFlow('updating');
    try {
      const applied = await endpoints.applyServerUpdate();
      setFlowLog(applied.log);
      if (!applied.updated) {
        setFlow('stuck');
        return;
      }
      setFlow('restarting');
      await endpoints.restartServer();
    } catch (err) {
      setFlowError(err);
      setFlow('none');
      return;
    }

    const wasVersion = result?.current;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        const { system } = await api.system();
        if (system.version && system.version !== wasVersion) {
          setFlow('back');
          setTimeout(() => window.location.reload(), 1200);
          return;
        }
      } catch {
        // Still restarting. The silence is the process swapping over.
      }
    }
    setFlow('stuck');
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={state === 'checking'}
          onClick={() => void check()}
        >
          {state === 'checking' && <Spinner />}
          Check for updates
        </button>

        {state === 'done' && result && !result.newer && (
          <span className="text-[12px] text-ok">You're on the latest version.</span>
        )}
        {state === 'failed' && (
          <span className="text-[12px] text-ink-muted">
            Couldn't reach GitHub. Try again in a moment.
          </span>
        )}
      </div>

      {state === 'done' && result?.newer && (
        <div className="mt-3 rounded-[var(--radius-card)] border border-accent/30 bg-accent-soft p-4">
          <p className="text-[13px] font-medium text-ink">
            Version {result.version} is available. You're on {result.current}.
          </p>
          <p className="mt-1.5 text-[12px] text-ink-muted">
            One press installs it and restarts Derailed. Your apps keep running while it swaps over;
            this dashboard is gone for a few seconds and comes back on the new version.
          </p>

          {flow === 'back' ? (
            <p className="mt-3 text-[13px] text-ok">
              Back on {result.version}. Reloading the dashboard…
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={flow === 'updating' || flow === 'restarting'}
                onClick={() => void updateAndRestart()}
              >
                {(flow === 'updating' || flow === 'restarting') && <Spinner />}
                {flow === 'updating'
                  ? 'Downloading the update…'
                  : flow === 'restarting'
                    ? 'Restarting Derailed…'
                    : `Update to ${result.version} and restart`}
              </button>
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary inline-flex"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                What changed
              </a>
            </div>
          )}

          {flow === 'updating' && (
            <p className="mt-2 text-[12px] text-ink-faint">
              The new version is about 90 MB; on a small server this takes a minute.
            </p>
          )}
          {flow === 'restarting' && (
            <p className="mt-2 text-[12px] text-ink-faint">
              Waiting for it to come back. The page reloads by itself.
            </p>
          )}
          {flow === 'stuck' && (
            <div className="mt-2 text-[12px] text-ink-muted">
              {flowLog.length > 0 ? (
                flowLog.map((line) => <p key={line}>{line}</p>)
              ) : (
                <p>
                  It's taking longer than it should. Refresh this page in a moment; if the version
                  hasn't changed, restart from the server with{' '}
                  <code className="text-ink">systemctl restart derailed</code>.
                </p>
              )}
            </div>
          )}
          <ErrorNote error={flowError} />
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="eyebrow mb-2.5">{title}</h2>
      <div className="card p-5">{children}</div>
    </section>
  );
}
