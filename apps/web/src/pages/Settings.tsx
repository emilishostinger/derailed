import type { FreeDomain } from '@derailed/shared';
import { ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { UpdateEmails } from '../components/UpdateEmails.tsx';
import { ErrorNote, Field, Spinner } from '../components/ui.tsx';
import { useSession } from '../stores/session.ts';
import { PageHeader } from './Layout.tsx';

export function Settings() {
  const user = useSession((s) => s.user);
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
            <p className="mt-2 text-[12px] text-ink-faint">
              To change the password, run{' '}
              <code className="text-ink-muted">derailed reset-password</code> on the server.
            </p>
          </Section>

          <Section title="Dashboard address">
            <PanelDomain />
          </Section>

          <Section title="A secure address, free">
            <FreeAddress />
          </Section>

          <Section title="Addresses for your apps">
            <AppDomain />
          </Section>

          <Section title="Keeping up to date">
            <UpdateCheck />
          </Section>

          <Section title="Update emails">
            <UpdateEmails />
          </Section>

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
        </div>
      </div>
    </>
  );
}

/**
 * A padlock without owning a domain.
 *
 * The ready-made sslip.io addresses can never be secured, and buying a domain is a
 * real barrier for someone putting their first thing on the internet. DuckDNS is the
 * way through: it is free, it takes a minute, and (the part that actually matters) it
 * is on the public suffix list, so a name under it has a certificate allowance of its
 * own instead of sharing one with every sslip.io user on earth.
 *
 * The screen deliberately does not explain any of that. It asks for two things that
 * are visible on one page of another website, and says what will happen.
 */
function FreeAddress() {
  const [state, setState] = useState<FreeDomain | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .freeDomain()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  async function claim() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await endpoints.claimFreeDomain(name.trim(), token.trim());
      setState(result.freeDomain);
      setToken('');
      setNote(
        result.added
          ? `Done. ${result.added} app${result.added === 1 ? '' : 's'} picked up a secured address just now.`
          : 'Done. Every app you deploy from now on gets a secured address here.',
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setState(await endpoints.releaseFreeDomain());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  if (state.hostname) {
    return (
      <div>
        <div className="mb-4 flex items-start gap-2 rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">
              Your apps are at <span className="text-ink-muted">shop.{state.hostname}</span>, with a
              real padlock.
            </p>
            <p className="mt-1 text-[12px] text-ink-faint">
              {state.secured && state.expiresAt
                ? `One certificate covers every app, now and in future. It renews by itself, next time around ${new Date(
                    state.expiresAt,
                  ).toLocaleDateString()}.`
                : 'The certificate is being sorted out. This usually takes under a minute.'}
            </p>
          </div>
        </div>

        {state.error && (
          <p className="mb-3 text-[12px] text-danger">
            Last renewal attempt: {state.error} Derailed keeps trying.
          </p>
        )}

        {note && <p className="mt-3 text-[12px] text-ok">{note}</p>}
        <ErrorNote error={error} />

        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void release()}>
          {busy && <Spinner />}
          Stop using this address
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-[13px] text-ink-muted">
        Don't own a domain? Get a free one from DuckDNS and every app here gets a proper padlock:
        not a warning page, a real certificate. It takes about a minute and costs nothing, ever.
      </p>

      <ol className="mb-4 space-y-2 text-[13px] text-ink">
        <li className="flex gap-2">
          <span className="text-ink-faint">1.</span>
          <span>
            Open{' '}
            <a
              className="link inline-flex items-center gap-1"
              href="https://www.duckdns.org"
              target="_blank"
              rel="noreferrer noopener"
            >
              duckdns.org
              <ExternalLink className="h-3 w-3" />
            </a>{' '}
            and sign in. Any of the sign-in buttons will do.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-ink-faint">2.</span>
          <span>Type a name you like and press add domain.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-ink-faint">3.</span>
          <span>Copy the name, and the token shown at the top of the page, into here.</span>
        </li>
      </ol>

      <div className="max-w-sm space-y-3">
        <Field label="The name you chose" hint="Just the first part, without .duckdns.org.">
          <input
            className="input"
            value={name}
            placeholder="my-server"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Your token" hint="The long code at the top of your DuckDNS page.">
          <input
            className="input"
            type="password"
            value={token}
            autoComplete="off"
            placeholder="a1b2c3d4-…"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      </div>

      {note && <p className="mt-3 text-[12px] text-ok">{note}</p>}
      <ErrorNote error={error} />

      <div className="mt-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !name.trim() || !token.trim()}
          onClick={() => void claim()}
        >
          {busy && <Spinner />}
          {busy ? 'Getting your certificate…' : 'Use this address'}
        </button>
      </div>
    </div>
  );
}

/**
 * Every app gets an address for free. This decides what those addresses look like.
 *
 * The ready-made ones spell out the server's IP, and can never be given a padlock:
 * that style of address is not on the public suffix list, so a certificate authority
 * counts every one of them in the world against a single small weekly allowance. A
 * domain of your own with a wildcard record fixes that once, for every app.
 */
function AppDomain() {
  const system = useSession((s) => s.system);
  const [current, setCurrent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .appDomain()
      .then((value) => {
        setCurrent(value);
        setDomain(value ?? '');
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await endpoints.setAppDomain(value);
      setCurrent(result.appDomain);
      setDomain(result.appDomain ?? '');
      if (result.appDomain) {
        setNote(
          result.added
            ? `Done. ${result.added} app${result.added === 1 ? '' : 's'} picked up a new address, and the padlock appears once each certificate arrives.`
            : 'Done. Every app deployed from now on gets an address here.',
        );
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div>
      {current ? (
        <div className="mb-4 flex items-center gap-2 rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft px-3.5 py-3">
          <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
          <p className="min-w-0 flex-1 text-[13px] text-ink">
            New apps get an address like <span className="text-ink-muted">shop.{current}</span>,
            secured automatically.
          </p>
        </div>
      ) : (
        <p className="mb-4 text-[13px] text-ink-muted">
          Right now apps get an address like{' '}
          <span className="">
            shop.{(system?.serverIp ?? '203.0.113.7').replace(/\./g, '-')}.sslip.io
          </span>
          . It works straight away and needs no setup, but it is plain HTTP and always will be:
          those addresses share one small certificate allowance with everyone else on the internet
          using them.
        </p>
      )}

      <div className="max-w-sm">
        <Field
          label="Domain for app addresses"
          hint={
            system?.serverIp
              ? `Add an A record for *.yourdomain pointing to ${system.serverIp}. Derailed checks it before switching.`
              : 'Add a wildcard A record pointing at this server first.'
          }
        >
          <input
            className="input"
            value={domain}
            placeholder="apps.example.com"
            onChange={(event) => setDomain(event.target.value)}
          />
        </Field>
      </div>

      {note && <p className="mt-3 text-[12px] text-ok">{note}</p>}
      <ErrorNote error={error} />

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !domain.trim() || domain.trim() === current}
          onClick={() => void save(domain.trim())}
        >
          {busy && <Spinner />}
          Use this domain
        </button>
        {current && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Go back to the ready-made ones
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Until this is set, the dashboard is only reachable over plain HTTP on its port -
 * which means this password crosses the internet in the clear every time you sign in.
 */
function PanelDomain() {
  const system = useSession((s) => s.system);
  const [current, setCurrent] = useState<string | null>(null);
  // Until this is known, "no domain set" and "not loaded yet" look identical, and
  // rendering the warning in the meantime accuses the user of something untrue for a
  // frame before correcting itself.
  const [loaded, setLoaded] = useState(false);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .panelDomain()
      .then((value) => {
        setCurrent(value);
        setHostname(value ?? '');
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      const saved = await endpoints.setPanelDomain(value);
      setCurrent(saved);
      setHostname(saved ?? '');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {current && loaded ? (
        <div className="mb-4 flex items-center gap-2 rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft px-3.5 py-3">
          <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
          <p className="min-w-0 flex-1 text-[13px] text-ink">
            The dashboard is served securely at{' '}
            <a
              href={`https://${current}`}
              className="text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              https://{current}
            </a>
          </p>
        </div>
      ) : !loaded ? null : (
        <div className="mb-4 flex gap-2.5 rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft px-3.5 py-3">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0 text-warn" />
          <div className="min-w-0 text-[13px]">
            <p className="text-ink">This dashboard is served over plain HTTP.</p>
            <p className="mt-1 text-ink-muted">
              Your password is sent unencrypted every time you sign in. Give it a domain below and
              Derailed will put it behind HTTPS.
            </p>
          </div>
        </div>
      )}

      <div className="max-w-sm">
        <Field
          label="Domain for the dashboard"
          hint={
            system?.serverIp
              ? `Point an A record at ${system.serverIp} first. Derailed checks before switching.`
              : 'Point an A record at this server first.'
          }
        >
          <input
            className="input"
            value={hostname}
            placeholder="dashboard.example.com"
            onChange={(event) => setHostname(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !hostname.trim()}
          onClick={() => void save(hostname.trim())}
        >
          {busy && <Spinner />}
          Use this domain
        </button>
        {current && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Stop using it
          </button>
        )}
      </div>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
      {current && (
        <p className="mt-3 text-[12px] text-ink-faint">
          Port {8422} is still open. Once you've confirmed the domain works, close it in your
          firewall so the dashboard is only reachable over HTTPS.
        </p>
      )}
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
            Update from the server with <code className="text-ink">derailed update</code>, then{' '}
            <code className="text-ink">systemctl restart derailed</code>. Your apps keep running
            while it swaps over.
          </p>
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary mt-3 inline-flex"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            What changed
          </a>
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
