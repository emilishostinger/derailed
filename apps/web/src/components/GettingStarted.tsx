import type { FreeDomain } from '@derailed/shared';
import { Check, Circle, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { cx, ErrorNote, Field, Spinner } from './ui.tsx';

/**
 * The first ten minutes.
 *
 * Everything here already existed somewhere, which was the problem: the free secure
 * address lived in Settings, a page nobody opens on their first day, so the ordinary
 * path was to deploy something, get an unsecured address, and never find out a
 * padlock had been one minute away the whole time.
 *
 * Three steps, in the order they actually matter, and it takes itself off the screen
 * when they are done.
 */
const DISMISSED = 'derailed.getting-started-dismissed';

export function GettingStarted() {
  const projects = useProjects((s) => s.projects);
  const [free, setFree] = useState<FreeDomain | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });

  const [ownDomain, setOwnDomain] = useState<string | null>(null);

  useEffect(() => {
    endpoints
      .freeDomain()
      .then(setFree)
      .catch(() => undefined);
    endpoints
      .appDomain()
      .then(setOwnDomain)
      .catch(() => undefined);
  }, []);

  const hasApp = projects.some((project) =>
    (project.services ?? []).some((service) => service.kind === 'app'),
  );
  // Either road leads to the padlock: the free DuckDNS name, or a domain of
  // your own with a wildcard record. Nagging someone who took the second road
  // about the first was this component's most embarrassing habit.
  const secured = !!free?.hostname || !!ownDomain;

  // Gone once both are true, and gone for good if it is waved away. Nobody wants a
  // checklist following them around a server they have been running for a year.
  if (dismissed || (hasApp && secured) || !free) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // Then it comes back next time. Harmless.
    }
    setDismissed(true);
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">Getting set up</p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            Two things worth doing on a new server. Neither takes long.
          </p>
        </div>
        <button
          type="button"
          aria-label="Hide this"
          className="shrink-0 text-ink-faint hover:text-ink"
          onClick={dismiss}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <ul className="divide-y divide-line border-t border-line">
        <Step done={hasApp} title="Put something on the internet">
          {!hasApp && (
            <p className="text-[12px] text-ink-faint">
              Make a project, then paste a repository link or drag in a folder of HTML. It is live
              about a minute later.
            </p>
          )}
        </Step>

        <Step done={secured} title={secured ? 'Your apps have a padlock' : 'Get a padlock, free'}>
          {secured ? (
            <p className="text-[12px] text-ink-faint">
              Everything is at{' '}
              <span className="text-ink-muted">something.{free?.hostname ?? ownDomain}</span>,
              secured.
            </p>
          ) : expanded ? (
            <ClaimFreeAddress
              onDone={(state) => {
                setFree(state);
                setExpanded(false);
              }}
            />
          ) : (
            <div>
              <p className="text-[12px] text-ink-faint">
                Right now your apps are on plain HTTP, and those addresses can never be secured.
                Fixable once, for every app at once: with a domain of your own (each app becomes{' '}
                <span className="text-ink-muted">something.apps.yourdomain.com</span>), or with a
                free name from DuckDNS.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Link to="/domains?tab=server" className="btn-secondary">
                  <ShieldCheck className="h-3.5 w-3.5" />I have a domain
                </Link>
                <button type="button" className="btn-ghost" onClick={() => setExpanded(true)}>
                  Get a free one
                </button>
              </div>
            </div>
          )}
        </Step>
      </ul>
    </div>
  );
}

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 p-4">
      {done ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cx('text-[13px]', done ? 'text-ink-muted line-through' : 'text-ink')}>
          {title}
        </p>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  );
}

/** The same two fields as Settings, at the moment somebody would actually want them. */
function ClaimFreeAddress({ onDone }: { onDone: (state: FreeDomain) => void }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="space-y-3">
      <ol className="space-y-1 text-[12px] text-ink-muted">
        <li>
          1. Open{' '}
          <a
            className="link inline-flex items-center gap-1"
            href="https://www.duckdns.org"
            target="_blank"
            rel="noreferrer noopener"
          >
            duckdns.org
            <ExternalLink className="h-3 w-3" />
          </a>{' '}
          and sign in with any of the buttons.
        </li>
        <li>2. Type a name you like and press add domain.</li>
        <li>3. Copy the name, and the token at the top of the page, into here.</li>
      </ol>

      <div className="grid max-w-md gap-2 sm:grid-cols-2">
        <Field label="The name you chose">
          <input
            className="input"
            value={name}
            placeholder="my-server"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Your token">
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      </div>

      <ErrorNote error={error} />

      <button
        type="button"
        className="btn-primary"
        disabled={busy || !name.trim() || !token.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onDone((await endpoints.claimFreeDomain(name.trim(), token.trim())).freeDomain);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />}
        {busy ? 'Getting your certificate…' : 'Use this address'}
      </button>
    </div>
  );
}
