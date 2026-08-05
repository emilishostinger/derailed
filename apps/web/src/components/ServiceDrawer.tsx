import type { Deployment, LogLine, Service } from '@derailed/shared';
import { ACTIVE_DEPLOYMENT_STATUSES, topics } from '@derailed/shared';
import {
  ExternalLink,
  Globe,
  Lock,
  Play,
  Rocket,
  RotateCcw,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { useProjects } from '../stores/projects.ts';
import { ConnectionTab } from './ConnectionTab.tsx';
import { DomainsTab } from './DomainsTab.tsx';
import { EnvEditor } from './EnvEditor.tsx';
import { LogViewer } from './LogViewer.tsx';
import { StorageTab } from './StorageTab.tsx';
import { ConfirmRiskyDeploy, StorageWarningBanner } from './StorageWarning.tsx';
import { TechIcon } from './TechIcon.tsx';
import { TerminalTab } from './TerminalTab.tsx';
import { TrafficTab } from './TrafficTab.tsx';
import { cx, ErrorNote, Spinner, StatusPill } from './ui.tsx';

type Tab =
  | 'overview'
  | 'traffic'
  | 'deployments'
  | 'variables'
  | 'connection'
  | 'storage'
  | 'terminal'
  | 'domains'
  | 'settings';

export function ServiceDrawer({
  service,
  initialTab,
  onClose,
}: {
  service: Service;
  initialTab?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? 'overview');
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useProjects((s) => s.load);

  useEffect(() => live.subscribe([topics.service(service.id)]), [service.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const isApp = service.kind === 'app';
  // The one someone would put on a business card: a domain they chose, else a secured
  // address, else whatever works. Sitting at the top because opening the site is the
  // most common reason to be on this screen at all.
  const domains = service.domains ?? [];
  const address =
    domains.find((domain) => domain.kind === 'custom' && domain.tlsStatus === 'active') ??
    domains.find((domain) => domain.tlsStatus === 'active') ??
    domains[0];
  const tabs: [Tab, string][] = isApp
    ? [
        ['overview', 'Overview'],
        ['traffic', 'Visitors'],
        ['deployments', 'Deploys'],
        ['variables', 'Variables'],
        ['connection', 'Connections'],
        ['storage', 'Storage'],
        ['terminal', 'Terminal'],
        ['domains', 'Domains'],
        ['settings', 'Settings'],
      ]
    : [
        ['overview', 'Overview'],
        ['connection', 'Connection'],
        ['variables', 'Variables'],
        ['terminal', 'Terminal'],
        ['settings', 'Settings'],
      ];

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="animate-overlay-in fixed inset-0 z-30 cursor-default bg-black/30"
        onClick={onClose}
      />
      <aside className="animate-drawer-in fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-[var(--d-shadow-pop)]">
        <header className="shrink-0 border-b border-line px-5 pt-4">
          <div className="flex items-start gap-2.5">
            <TechIcon service={service} className="mt-0.5 h-7 w-7 text-[11px]" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold text-ink">{service.name}</h2>
              <p className="mt-0.5 truncate text-[12px] text-ink-muted">
                {!isApp
                  ? `${service.dbEngine} ${service.dbVersion}`
                  : service.source === 'image'
                    ? service.image
                    : (service.repoUrl?.replace(/^https:\/\/|\.git$/g, '') ?? 'No repository')}
              </p>
            </div>
            <StatusPill status={service.status ?? 'stopped'} />
            <button type="button" className="btn-ghost px-1.5" aria-label="Close" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>

          {address && (
            <a
              href={`${address.tlsStatus === 'active' ? 'https' : 'http'}://${address.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 flex items-center gap-1.5 truncate font-mono text-[12px] text-accent hover:underline"
            >
              {address.tlsStatus === 'active' ? (
                <Lock className="h-3 w-3 shrink-0 text-ok" />
              ) : (
                <Globe className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{address.hostname}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </a>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {address && (
              <a
                href={`${address.tlsStatus === 'active' ? 'https' : 'http'}://${address.hostname}`}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            )}
            {isApp && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null}
                onClick={() => {
                  // A deploy replaces the container, so an app with data and no
                  // storage is about to lose it. Ask first, once, with a way out.
                  if (service.storageWarning) setConfirmDeploy(true);
                  else void act('deploy', () => endpoints.deploy(service.id));
                }}
              >
                {busy === 'deploy' ? <Spinner /> : <Rocket className="h-3.5 w-3.5" />}
                Deploy
              </button>
            )}
            {service.status === 'running' ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy !== null}
                onClick={() => void act('stop', () => endpoints.stopService(service.id))}
              >
                {busy === 'stop' ? <Spinner /> : <Square className="h-3.5 w-3.5" />}
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy !== null}
                onClick={() => void act('start', () => endpoints.startService(service.id))}
              >
                {busy === 'start' ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                Start
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              disabled={busy !== null || service.status !== 'running'}
              onClick={() => void act('restart', () => endpoints.restartService(service.id))}
            >
              {busy === 'restart' ? <Spinner /> : <RotateCw className="h-3.5 w-3.5" />}
              Restart
            </button>
          </div>

          <nav className="-mb-px mt-3 flex gap-4 overflow-x-auto">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cx(
                  'shrink-0 border-b-2 pb-2.5 text-[13px] font-medium transition-colors',
                  tab === key
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          <ErrorNote error={error} />
          {tab === 'overview' && (
            <>
              <StorageWarningBanner service={service} />
              <Overview service={service} />
            </>
          )}
          {tab === 'traffic' && <TrafficTab service={service} />}
          {tab === 'deployments' && <Deployments service={service} />}
          {tab === 'variables' && <EnvEditor serviceId={service.id} />}
          {tab === 'connection' && <ConnectionTab service={service} />}
          {tab === 'storage' && <StorageTab service={service} />}
          {tab === 'terminal' && <TerminalTab service={service} />}
          {tab === 'domains' && <DomainsTab service={service} />}
          {tab === 'settings' && <Settings service={service} onClose={onClose} />}
        </div>
      </aside>

      {confirmDeploy && service.storageWarning && (
        <ConfirmRiskyDeploy
          service={service}
          onCancel={() => setConfirmDeploy(false)}
          onDeploy={() => {
            setConfirmDeploy(false);
            void act('deploy', () => endpoints.deploy(service.id));
          }}
        />
      )}
    </>
  );
}

function Overview({ service }: { service: Service }) {
  const stats = useProjects((s) => s.stats[service.id]);
  const latest = service.latestDeployment;
  const [lines, setLines] = useState<LogLine[]>([]);
  const storeLogs = useProjects((s) => (latest ? s.logs[latest.id] : undefined));

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a different deployment should re-fetch and re-subscribe, `latest` changes identity on every status tick.
  useEffect(() => {
    if (!latest) return;
    let cancelled = false;
    endpoints
      .deploymentLogs(latest.id, 200)
      .then((result) => !cancelled && setLines(result))
      .catch(() => undefined);
    const unsubscribe = live.subscribe([topics.deployment(latest.id)]);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [latest?.id]);

  const merged = useMemo(() => [...lines, ...(storeLogs ?? [])], [lines, storeLogs]);

  return (
    <div className="space-y-5">
      {latest?.status === 'failed' && latest.errorSummary && (
        <div className="rounded-[var(--radius-card)] border border-danger/25 bg-danger-soft p-4">
          <p className="text-sm font-medium text-ink">{latest.errorSummary}</p>
          {latest.errorHint && <p className="mt-1 text-sm text-ink-muted">{latest.errorHint}</p>}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Detail label="Status" value={service.status ?? 'stopped'} />
        <Detail
          label="Last deploy"
          value={latest ? new Date(latest.createdAt).toLocaleString() : 'Never'}
        />
        {service.kind === 'app' && (
          <>
            <Detail label="Branch" value={service.branch ?? '-'} />
            <Detail label="Port" value={service.port ? String(service.port) : 'detected'} />
          </>
        )}
        {stats && (
          <>
            <Detail label="CPU" value={`${stats.cpuPercent.toFixed(1)}%`} />
            <Detail label="Memory" value={formatBytes(stats.memoryBytes)} />
          </>
        )}
      </dl>

      <div>
        <p className="eyebrow mb-2">Output</p>
        <LogViewer
          lines={merged}
          className="h-80"
          summarise
          emptyMessage="No output yet. Deploy to see what happens."
        />
      </div>
    </div>
  );
}

function Deployments({ service }: { service: Service }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const liveLogs = useProjects((s) => s.logs);
  const liveDeployments = useProjects((s) => s.deployments);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the history list only needs refetching when the newest deploy changes state, not on every stats tick.
  useEffect(() => {
    endpoints
      .deployments(service.id)
      .then(setDeployments)
      .catch(() => undefined);
  }, [service.id, service.latestDeployment?.status]);

  const rows = deployments.map((entry) => liveDeployments[entry.id] ?? entry);

  async function toggle(deployment: Deployment) {
    if (expanded === deployment.id) {
      setExpanded(null);
      return;
    }
    setExpanded(deployment.id);
    if (!logs[deployment.id]) {
      const lines = await endpoints.deploymentLogs(deployment.id, 2000).catch(() => []);
      setLogs((current) => ({ ...current, [deployment.id]: lines }));
    }
  }

  if (!rows.length) return <p className="hint">No deploys yet.</p>;

  return (
    <div className="space-y-2">
      {rows.map((deployment) => {
        const active = ACTIVE_DEPLOYMENT_STATUSES.includes(deployment.status);
        return (
          <div key={deployment.id} className="card overflow-hidden">
            <button
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
              onClick={() => void toggle(deployment)}
            >
              <StatusPill
                status={
                  deployment.status === 'running'
                    ? 'running'
                    : active
                      ? 'deploying'
                      : deployment.status === 'failed'
                        ? 'failed'
                        : 'stopped'
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {deployment.commitMessage ?? statusLabel(deployment.status)}
                </p>
                <p className="text-xs text-ink-muted">
                  {new Date(deployment.createdAt).toLocaleString()}
                  {deployment.commitSha ? ` · ${deployment.commitSha.slice(0, 7)}` : ''}
                </p>
              </div>
              {active ? (
                <button
                  type="button"
                  className="btn-ghost text-[12px] text-danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    void endpoints.cancelDeployment(deployment.id).catch(() => undefined);
                  }}
                >
                  Cancel
                </button>
              ) : (
                // Only a deploy that actually served traffic has an image worth going back to.
                deployment.status === 'superseded' && (
                  <button
                    type="button"
                    className="btn-ghost text-[12px]"
                    title="Run this version again. No rebuild"
                    onClick={(event) => {
                      event.stopPropagation();
                      void endpoints.rollback(deployment.id).catch(() => undefined);
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Roll back
                  </button>
                )
              )}
            </button>

            {expanded === deployment.id && (
              <div className="border-t border-line p-4">
                {deployment.errorSummary && (
                  <div className="mb-3 rounded-[var(--radius-card)] border border-danger/25 bg-danger-soft p-3">
                    <p className="text-sm text-ink">{deployment.errorSummary}</p>
                    {deployment.errorHint && (
                      <p className="mt-1 text-sm text-ink-muted">{deployment.errorHint}</p>
                    )}
                  </div>
                )}
                <LogViewer
                  className="h-72"
                  lines={[...(logs[deployment.id] ?? []), ...(liveLogs[deployment.id] ?? [])]}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Settings({ service, onClose }: { service: Service; onClose: () => void }) {
  const load = useProjects((s) => s.load);
  const [name, setName] = useState(service.name);
  const [branch, setBranch] = useState(service.branch ?? '');
  const [rootDir, setRootDir] = useState(service.rootDir ?? '');
  const [port, setPort] = useState(service.port ? String(service.port) : '');
  const [healthPath, setHealthPath] = useState(service.healthPath);
  const [memory, setMemory] = useState(service.memoryLimitMb ? String(service.memoryLimitMb) : '');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await endpoints.patchService(service.id, {
        name,
        ...(service.kind === 'app'
          ? {
              branch: branch || undefined,
              rootDir: rootDir || null,
              port: port ? Number(port) : null,
              healthPath: healthPath || '/',
            }
          : {}),
        memoryLimitMb: memory ? Number(memory) : null,
      });
      await load();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="block">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {service.kind === 'app' && service.source === 'repo' && <RepoToken service={service} />}

        {service.kind === 'app' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Branch</span>
                <input
                  className="input"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Folder</span>
                <input
                  className="input"
                  value={rootDir}
                  placeholder="(the whole repository)"
                  onChange={(e) => setRootDir(e.target.value)}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Port</span>
                <input
                  className="input"
                  value={port}
                  placeholder="detected automatically"
                  onChange={(e) => setPort(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Health path</span>
                <input
                  className="input"
                  value={healthPath}
                  onChange={(e) => setHealthPath(e.target.value)}
                />
              </label>
            </div>
          </>
        )}

        <label className="block">
          <span className="label">Memory limit (MB)</span>
          <input
            className="input"
            value={memory}
            placeholder="no limit"
            onChange={(e) => setMemory(e.target.value)}
          />
        </label>

        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy && <Spinner />}
            Save
          </button>
          {saved && <span className="text-xs text-ok">Saved. Redeploy to apply.</span>}
        </div>
        <ErrorNote error={error} />
      </div>

      <div className="rounded-lg border border-danger/30 p-4">
        <p className="text-sm font-semibold text-ink">Delete {service.name}</p>
        <p className="mt-1 text-sm text-ink-muted">
          This stops it, removes its container
          {service.kind === 'database' ? ', and destroys all of its data' : ''}, and can't be
          undone.
        </p>
        <input
          className="input mt-3"
          placeholder={`Type ${service.name} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          type="button"
          className="btn-danger mt-3"
          disabled={confirm !== service.name || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await endpoints.deleteService(service.id);
              await load();
              onClose();
            } catch (err) {
              setError(err);
              setBusy(false);
            }
          }}
        >
          Delete it
        </button>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-ink tabular">{value}</dd>
    </div>
  );
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Private repositories. The token is write-only: it can be replaced or cleared but
 * never read back, so it can't be harvested from a stolen session.
 */
function RepoToken({ service }: { service: Service }) {
  const load = useProjects((s) => s.load);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      await endpoints.setRepoToken(service.id, value);
      await load();
      setToken('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-line p-4">
      <p className="text-[13px] font-medium text-ink">Private repository</p>
      <p className="mt-1 text-[12px] text-ink-muted">
        {service.hasRepoToken
          ? 'A token is saved. Derailed uses it to fetch your code and never shows it again.'
          : 'If this repository is private, give Derailed a token so it can read it. Create a fine-grained personal access token on GitHub with read access to just this repository.'}
      </p>

      <div className="mt-3 flex gap-2">
        <input
          className="input font-mono text-[12px]"
          type="password"
          value={token}
          placeholder={service.hasRepoToken ? 'Replace the saved token' : 'github_pat_…'}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={busy || !token.trim()}
          onClick={() => void save(token.trim())}
        >
          {busy && <Spinner />}
          Save
        </button>
        {service.hasRepoToken && (
          <button
            type="button"
            className="btn-ghost shrink-0 text-danger"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Remove
          </button>
        )}
      </div>
      <div className="mt-2">
        <ErrorNote error={error} />
      </div>
    </div>
  );
}
