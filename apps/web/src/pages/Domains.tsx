import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  CornerDownRight,
  ExternalLink,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Unlock,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.tsx';
import { CopyButton, cx, EmptyState, ErrorNote, Modal, Spinner } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { PageHeader } from './Layout.tsx';

export interface DomainRow {
  id: string;
  hostname: string;
  kind: 'generated' | 'custom';
  dnsStatus: 'unchecked' | 'ok' | 'wrong_ip' | 'no_record';
  tlsStatus: 'pending' | 'active' | 'error' | 'disabled';
  /** Set on the half of a pair that redirects, pointing at the one people see. */
  redirectTo?: string | null;
  serviceId: string | null;
  serviceName: string | null;
  serviceStatus: string | null;
  projectName: string | null;
  projectSlug: string | null;
}

/**
 * Domains.
 *
 * The job here is the one people arrive with: I own a name, is it pointing at this
 * server, and what answers on it. Adding a domain and choosing what runs on it are
 * separate steps, because in real life they happen days apart, and requiring an app
 * first meant you could not add a domain until you had somewhere to put it.
 */
export function Domains() {
  const serverIp = useSession((s) => s.system?.serverIp);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function refresh() {
    try {
      setDomains(await endpoints.allDomains());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh poll loop on every render would stack up timers.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Only the ones you own. The addresses Derailed hands out are part of the app that
  // was given them, and live on that app's page: this screen is about domains.
  const own = domains.filter((domain) => domain.kind === 'custom' && !domain.redirectTo);
  const redirects = domains.filter((domain) => domain.kind === 'custom' && domain.redirectTo);
  const waiting = own.filter((domain) => domain.dnsStatus !== 'ok').length;

  return (
    <>
      <PageHeader
        title="Domains"
        subtitle={waiting > 0 ? `${waiting} waiting on DNS` : undefined}
        actions={
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add a domain
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-20 text-ink-faint">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {!loading && (
          <div className="mx-auto max-w-3xl space-y-8 p-5">
            <ErrorNote error={error} />

            <section>
              {own.length === 0 ? (
                <EmptyState
                  icon={<Globe className="h-5 w-5" />}
                  title="No domains yet"
                  body="Add a domain you own and Derailed checks that it points at this server. Once it does, any of your apps can answer on it."
                  action={
                    <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
                      Add a domain
                    </button>
                  }
                />
              ) : (
                <div className="space-y-2">
                  {own.map((domain) => (
                    <Row
                      key={domain.id}
                      domain={domain}
                      partner={redirects.find((entry) => entry.redirectTo === domain.id)}
                      serverIp={serverIp}
                      onChange={refresh}
                    />
                  ))}
                </div>
              )}
            </section>

            <p className="text-[12px] text-ink-faint">
              Every app also gets an address from Derailed automatically. Those live on the app's
              own page, under Domains.
            </p>
          </div>
        )}
      </div>

      {adding && (
        <AddDomain
          serverIp={serverIp}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function AddDomain({
  serverIp,
  onClose,
  onAdded,
}: {
  serverIp?: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [hostname, setHostname] = useState('');
  const [alsoWww, setAlsoWww] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<DomainRow[] | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const { domains } = await endpoints.addOwnDomain(hostname.trim().toLowerCase(), alsoWww);
      setResult(domains);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Only an apex domain has a www version worth offering.
  const apex = hostname.trim().split('.').filter(Boolean).length === 2;

  return (
    <Modal title="Add a domain" onClose={onClose}>
      {result ? (
        <div className="space-y-4">
          {result.map((domain) => (
            <div key={domain.id} className="rounded-[var(--radius-card)] border border-line p-3.5">
              <p className="flex items-center gap-2 font-mono text-[13px] text-ink">
                {domain.dnsStatus === 'ok' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
                ) : (
                  <Clock className="h-3.5 w-3.5 shrink-0 text-warn" />
                )}
                {domain.hostname}
              </p>
              <p className="mt-1.5 text-[12px] text-ink-muted">
                {domain.dnsStatus === 'ok'
                  ? 'Points at this server. Choose which app answers on it whenever you like.'
                  : `Not pointing here yet. At your domain provider, add an A record for ${domain.hostname} pointing to ${serverIp ?? 'this server'}. Derailed keeps checking.`}
              </p>
            </div>
          ))}
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onAdded}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="label">Domain</span>
            <input
              className="input"
              placeholder="example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && hostname.trim() && void add()}
            />
          </label>

          {apex && (
            <label className="flex items-center gap-2 text-[12px] text-ink-muted">
              <input
                type="checkbox"
                checked={alsoWww}
                onChange={(event) => setAlsoWww(event.target.checked)}
              />
              Also add www.{hostname.trim()}
            </label>
          )}

          <div className="rounded-[var(--radius-card)] border border-line bg-surface-2 p-3 text-[12px] text-ink-muted">
            At your domain provider, add an <span className="font-mono text-ink">A</span> record
            pointing to <span className="font-mono text-ink">{serverIp ?? 'this server'}</span>. You
            can add it here first: Derailed keeps checking until the domain points at you.
          </div>

          <ErrorNote error={error} />

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !hostname.trim()}
              onClick={() => void add()}
            >
              {busy && <Spinner />}
              Add it
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({
  domain,
  partner,
  serverIp,
  onChange,
}: {
  domain: DomainRow;
  /** The www half, when this domain has one pointing at it. */
  partner?: DomainRow;
  serverIp?: string | null;
  onChange: () => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects((s) => s.projects);
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const menu = useContextMenu();
  const secure = domain.tlsStatus === 'active';
  const url = `${secure ? 'https' : 'http'}://${domain.hostname}`;
  const ready = domain.kind === 'generated' || domain.dnsStatus === 'ok';

  async function check() {
    setChecking(true);
    await endpoints.checkDomain(domain.id).catch(() => undefined);
    onChange();
    setChecking(false);
  }

  const apps = projects.flatMap((project) =>
    (project.services ?? [])
      .filter((service) => service.kind === 'app')
      .map((service) => ({ id: service.id, label: `${project.name} / ${service.name}` })),
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut here, and everything in the menu is also reachable by clicking.
    <div className="card p-4" onContextMenu={menu.onContextMenu}>
      <div className="flex items-center gap-2">
        {secure ? (
          <Lock className="h-3.5 w-3.5 shrink-0 text-ok" />
        ) : ready ? (
          <Unlock className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        ) : (
          <Clock className="h-3.5 w-3.5 shrink-0 text-warn" />
        )}

        <span className="min-w-0 flex-1">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-[13px] text-ink hover:text-accent hover:underline"
          >
            {domain.hostname}
          </a>
        </span>

        <CopyButton value={url} />
        <a href={url} target="_blank" rel="noreferrer" className="btn-ghost px-1.5">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {partner && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-faint">
          <CornerDownRight className="h-3 w-3 shrink-0" />
          <span className="font-mono">{partner.hostname}</span>
          sends people here
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={async () => {
              await endpoints.makePrimary(partner.id).catch(() => undefined);
              onChange();
            }}
          >
            (swap them)
          </button>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
        {domain.serviceName && domain.projectSlug ? (
          <Link to={`/p/${domain.projectSlug}`} className="truncate hover:text-ink">
            {domain.projectName} / {domain.serviceName}
          </Link>
        ) : domain.kind === 'custom' ? (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => setChoosing(true)}
          >
            Choose an app
          </button>
        ) : null}
        <span className={cx('flex items-center gap-1', ready ? 'text-ok' : 'text-warn')}>
          {ready ? <CheckCircle2 className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
          {statusLabel(domain)}
        </span>
      </div>

      {domain.kind === 'custom' && domain.dnsStatus !== 'ok' && serverIp && (
        <div className="mt-2.5 rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-[12px] text-ink-muted">
          At your domain provider, add an <span className="font-mono text-ink">A</span> record for{' '}
          <span className="font-mono text-ink">{domain.hostname}</span> pointing to{' '}
          <span className="font-mono text-ink">{serverIp}</span>. Derailed keeps checking. A new
          record can take a few minutes to reach everyone, so this is normal at first.
          <button
            type="button"
            className="btn-secondary mt-2.5 flex text-[12px]"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking && <Spinner />}
            Check now
          </button>
        </div>
      )}

      {choosing && (
        <Modal
          title={`What should answer on ${domain.hostname}?`}
          onClose={() => setChoosing(false)}
        >
          <div className="space-y-2">
            {apps.length === 0 && (
              <p className="hint">There are no apps yet. Create one, then come back.</p>
            )}
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-left text-[13px] text-ink transition-colors hover:border-line-strong"
                onClick={async () => {
                  await endpoints.setDomainService(domain.id, app.id).catch(() => undefined);
                  setChoosing(false);
                  onChange();
                }}
              >
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                {app.label}
              </button>
            ))}
            {domain.serviceId && (
              <button
                type="button"
                className="btn-ghost mt-1 text-[12px]"
                onClick={async () => {
                  await endpoints.setDomainService(domain.id, null).catch(() => undefined);
                  setChoosing(false);
                  onChange();
                }}
              >
                Take it off {domain.serviceName}
              </button>
            )}
          </div>
        </Modal>
      )}

      <ContextMenu
        at={menu.at}
        onClose={menu.close}
        items={[
          {
            label: 'Visit',
            icon: <ExternalLink className="h-3.5 w-3.5" />,
            onSelect: () => window.open(url, '_blank', 'noreferrer'),
          },
          {
            label: 'Copy the address',
            icon: <Copy className="h-3.5 w-3.5" />,
            onSelect: () => void navigator.clipboard.writeText(url).catch(() => undefined),
          },
          ...(domain.projectSlug
            ? [
                {
                  label: 'Go to the app',
                  icon: <ArrowRight className="h-3.5 w-3.5" />,
                  onSelect: () => navigate(`/p/${domain.projectSlug}`),
                },
              ]
            : []),
          ...(domain.kind === 'custom'
            ? [
                {
                  label: domain.serviceId ? 'Use for another app' : 'Choose an app',
                  icon: <Globe className="h-3.5 w-3.5" />,
                  separated: true,
                  onSelect: () => setChoosing(true),
                },
                {
                  label: 'Check DNS now',
                  icon: <RefreshCw className="h-3.5 w-3.5" />,
                  onSelect: () => void check(),
                },
                {
                  label: 'Remove',
                  icon: <Trash2 className="h-3.5 w-3.5" />,
                  danger: true,
                  separated: true,
                  onSelect: () => setConfirmRemove(true),
                },
              ]
            : []),
        ]}
      />

      {confirmRemove && (
        <Modal title={`Remove ${domain.hostname}`} onClose={() => setConfirmRemove(false)}>
          <div className="space-y-4">
            <p className="text-[13px] text-ink">
              The app stays exactly as it is. It simply stops answering at this address, so anyone
              using it sees nothing until you add it back.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmRemove(false)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={async () => {
                  await endpoints.deleteDomain(domain.id).catch(() => undefined);
                  setConfirmRemove(false);
                  onChange();
                }}
              >
                Remove it
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function statusLabel(domain: DomainRow): string {
  if (domain.tlsStatus === 'active') return 'Secure';
  if (domain.kind === 'generated' && domain.tlsStatus === 'disabled') return 'Working';
  if (domain.dnsStatus === 'wrong_ip') return 'Points somewhere else';
  if (domain.dnsStatus === 'no_record') return "Doesn't point anywhere yet";
  if (domain.dnsStatus === 'unchecked') return 'Checking…';
  if (!domain.serviceId) return 'Points here, not in use yet';
  return 'Getting a certificate…';
}
