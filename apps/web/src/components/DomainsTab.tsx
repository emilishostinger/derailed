import type { Domain, Service } from '@derailed/shared';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useSession } from '../stores/session.ts';
import { QrCode } from './QrCode.tsx';
import { cx, ErrorNote, Select, Spinner, StatusDot } from './ui.tsx';

export function DomainsTab({ service }: { service: Service }) {
  const serverIp = useSession((s) => s.system?.serverIp);
  const [domains, setDomains] = useState<Domain[]>(service.domains ?? []);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Domains added on the Domains page that nothing is using yet. Offering them here
  // saves retyping a name that is already set up and already checked.
  const [spare, setSpare] = useState<{ id: string; hostname: string }[]>([]);

  const typed = hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  // A bare name like example.com has a www half worth setting up. A subdomain such as
  // app.example.com does not: www.app.example.com is nobody's address.
  const pairable = typed.split('.').filter(Boolean).length === 2;

  async function refresh() {
    setDomains(await endpoints.domains(service.id).catch(() => domains));
  }

  async function loadSpare() {
    const all = await endpoints.allDomains().catch(() => []);
    setSpare(all.filter((entry) => entry.kind === 'custom' && !entry.serviceId));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is recreated every render; re-running on anything but a service change would restart the poll loop.
  useEffect(() => {
    void refresh();
    void loadSpare();
    // Custom domains flip from "waiting" to "ready" once DNS propagates.
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [service.id]);

  const automatic = domains.filter(
    (domain) => domain.kind === 'generated' && !isIpBased(domain.hostname),
  );
  const temporary = domains.filter(
    (domain) => domain.kind === 'generated' && isIpBased(domain.hostname),
  );
  const custom = domains.filter((domain) => domain.kind === 'custom');

  async function add() {
    setBusy(true);
    setError(null);
    try {
      setDomains(await endpoints.addDomain(service.id, typed, pairable));
      setHostname('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow mb-2">Your domains</p>
        <div className="space-y-3">
          {custom.map((domain) => (
            <DomainCard key={domain.id} domain={domain} serverIp={serverIp} onChange={refresh} />
          ))}

          {spare.length > 0 && (
            <div className="rounded-[var(--radius-card)] border border-line bg-surface-2 p-3">
              <p className="mb-2 text-[12px] text-ink-muted">
                Point one you already added at this app:
              </p>
              {/* A dropdown, so a pile of parked domains stays one control. Picking
                  one attaches it. */}
              <Select
                ariaLabel="Point an existing domain at this app"
                value=""
                placeholder="An unused domain…"
                options={spare.map((domain) => ({ value: domain.id, label: domain.hostname }))}
                onChange={async (domainId) => {
                  await endpoints.setDomainService(domainId, service.id).catch(() => undefined);
                  await refresh();
                  await loadSpare();
                }}
              />
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="input"
              placeholder="app.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
            <button
              type="button"
              className="btn-primary shrink-0"
              disabled={busy || !hostname.trim()}
              onClick={() => void add()}
            >
              {busy && <Spinner />}
              Add
            </button>
          </div>
          {/* Told, not asked. The www half always comes with an apex domain, and it
              redirects to the one typed here, which is the same rule the Domains page
              follows. Turning it around is a click on the row there. */}
          {pairable && (
            <p className="text-xs text-ink-muted">
              <span className="text-ink">www.{typed}</span> comes with it and sends people to{' '}
              <span className="text-ink">{typed}</span>.
            </p>
          )}
          <ErrorNote error={error} />
        </div>
      </section>

      {automatic.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Automatic address</p>
          <div className="space-y-3">
            {automatic.map((domain) => (
              <DomainCard key={domain.id} domain={domain} onChange={refresh} />
            ))}
          </div>
        </section>
      )}

      {/* Only worth a section when there is one, or when nothing else has been given
          out yet and the app is waiting for its first address. */}
      {(temporary.length > 0 || automatic.length === 0) && (
        <section>
          <p className="eyebrow mb-2">Temporary address</p>
          <div className="space-y-3">
            {temporary.length === 0 ? (
              <p className="hint">This app gets one as soon as it goes live for the first time.</p>
            ) : (
              temporary.map((domain) => (
                <DomainCard key={domain.id} domain={domain} onChange={refresh} />
              ))
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** sslip.io and nip.io spell out an IP, and cannot be given a certificate. */
function isIpBased(hostname: string): boolean {
  return hostname.endsWith('.sslip.io') || hostname.endsWith('.nip.io');
}

function DomainCard({
  domain,
  serverIp,
  onChange,
}: {
  domain: Domain;
  serverIp?: string | null;
  onChange: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [path, setPath] = useState(domain.pathPrefix ?? '');
  const secure = domain.tlsStatus === 'active';
  const proxyHttpPort = useSession((s) => s.system?.proxyHttpPort);
  const port = !secure && proxyHttpPort && proxyHttpPort !== 80 ? `:${proxyHttpPort}` : '';
  const url = `${secure ? 'https' : 'http'}://${domain.hostname}${port}${domain.pathPrefix ?? ''}`;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <StatusDot status={statusDot(domain)} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium text-ink hover:text-accent"
        >
          {domain.hostname}
          {domain.pathPrefix && <span className="text-ink-muted">{domain.pathPrefix}</span>}
        </a>
        <div className="ml-auto shrink-0">
          <QrCode url={url} label={domain.hostname} />
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0 px-2 py-1"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {domain.kind === 'custom' && (
          <button
            type="button"
            className="btn-ghost shrink-0 px-2 py-1 text-danger"
            onClick={async () => {
              await endpoints.deleteDomain(domain.id).catch(() => undefined);
              onChange();
            }}
          >
            Remove
          </button>
        )}
      </div>

      {/* Several apps can share one domain, each answering on its own path. Nobody
          thinks in reverse proxy rules; everybody thinks "my blog at /blog". */}
      {domain.kind === 'custom' && (
        <div className="mt-2 text-xs">
          {editingPath ? (
            <div className="flex items-center gap-2">
              <input
                className="input h-7 max-w-[12rem] text-xs"
                value={path}
                placeholder="/blog"
                onChange={(event) => setPath(event.target.value)}
              />
              <button
                type="button"
                className="btn-secondary px-2 py-1"
                onClick={async () => {
                  await endpoints
                    .setDomainPath(domain.id, path.trim() || null)
                    .catch(() => undefined);
                  setEditingPath(false);
                  onChange();
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                onClick={() => {
                  setPath(domain.pathPrefix ?? '');
                  setEditingPath(false);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="text-ink-faint hover:text-ink"
              onClick={() => setEditingPath(true)}
            >
              {domain.pathPrefix
                ? `Answers on ${domain.pathPrefix} only. Change`
                : 'Answers on the whole domain. Put it on a path instead'}
            </button>
          )}
        </div>
      )}

      {domain.kind === 'generated' ? (
        <p className="mt-2 text-xs text-ink-muted">
          {isIpBased(domain.hostname)
            ? "Works straight away with no setup. It's plain HTTP and always will be, so add a domain of your own for the padlock."
            : 'Given to this app automatically, on the domain set in Settings, with its own certificate.'}
        </p>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <Checklist
            done={domain.dnsStatus === 'ok'}
            label={
              domain.dnsStatus === 'ok'
                ? 'This domain points at your server.'
                : domain.dnsStatus === 'wrong_ip'
                  ? 'This domain points somewhere else.'
                  : domain.dnsStatus === 'no_record'
                    ? "This domain doesn't point anywhere yet."
                    : 'Checking where this domain points…'
            }
          />
          {domain.dnsStatus !== 'ok' && serverIp && (
            <p className="rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-xs text-ink-muted">
              At your domain provider, add an <span className="text-ink">A</span> record for{' '}
              <span className="text-ink">{domain.hostname}</span> pointing to{' '}
              <span className="text-ink">{serverIp}</span>. Derailed keeps checking. This usually
              takes a few minutes.
            </p>
          )}
          <Checklist
            done={secure}
            label={
              secure
                ? 'Secure connection is on (https).'
                : domain.dnsStatus === 'ok'
                  ? 'Getting a security certificate…'
                  : 'Security certificate comes next.'
            }
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await endpoints.checkDomain(domain.id).catch(() => undefined);
              onChange();
              setChecking(false);
            }}
          >
            {checking && <Spinner />}
            Check now
          </button>
        </div>
      )}
    </div>
  );
}

function Checklist({ done, label }: { done: boolean; label: string }) {
  return (
    <p className={cx('flex items-start gap-2', done ? 'text-ink' : 'text-ink-muted')}>
      <span className={cx('mt-0.5 shrink-0', done ? 'text-ok' : 'text-ink-faint')}>
        {done ? '✓' : '○'}
      </span>
      {label}
    </p>
  );
}

function statusDot(domain: Domain): string {
  if (domain.kind === 'generated') return 'running';
  if (domain.dnsStatus !== 'ok') return 'stopped';
  return domain.tlsStatus === 'active' ? 'running' : 'deploying';
}
