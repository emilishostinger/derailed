import type { Deployment, LogLine, Service } from '@derailed/shared';
import { ACTIVE_DEPLOYMENT_STATUSES, topics } from '@derailed/shared';
import {
  Activity,
  Braces,
  ChevronDown,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Gauge,
  Globe,
  HardDrive,
  Inbox,
  LayoutDashboard,
  Link2,
  Lock,
  type LucideIcon,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  ScrollText,
  Settings as SettingsIcon,
  Shield,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Table2,
  Users,
  Wand2,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { useProjects } from '../stores/projects.ts';
import { toastUndo } from '../stores/toasts.ts';
import { AccessTab } from './AccessTab.tsx';
import { BrowseTab } from './BrowseTab.tsx';
import { ConnectionTab } from './ConnectionTab.tsx';
import { DbUpgradeCard } from './DbUpgrade.tsx';
import { DomainsTab } from './DomainsTab.tsx';
import { EnvEditor } from './EnvEditor.tsx';
import { FilesWorkspace } from './FilesTab.workspace.tsx';
import { JobsTab } from './JobsTab.tsx';
import { LogsTab } from './LogsTab.tsx';
import { LogViewer } from './LogViewer.tsx';
import { MessagesTab } from './MessagesTab.tsx';
import { MetricsTab } from './MetricsTab.tsx';
import { PreviewBranches } from './PreviewBranches.tsx';
import { Snapshots } from './Snapshots.tsx';
import { StorageTab } from './StorageTab.tsx';
import { ConfirmRiskyDeploy, StorageWarningBanner } from './StorageWarning.tsx';
import { TechIcon } from './TechIcon.tsx';
import { TerminalTab } from './TerminalTab.tsx';
import { TrafficTab } from './TrafficTab.tsx';
import { UpdatesTab } from './UpdatesTab.tsx';
import { cx, ErrorNote, Spinner, StatusPill, Switch } from './ui.tsx';
import { useDrawerWidth } from './useDrawerWidth.ts';
import { WhyBroken } from './WhyBroken.tsx';
import { WordPressTab } from './WordPressTab.tsx';

type Tab =
  | 'overview'
  | 'snapshots'
  | 'updates'
  | 'messages'
  | 'traffic'
  | 'logs'
  | 'metrics'
  | 'browse'
  | 'files'
  | 'wordpress'
  | 'deployments'
  | 'variables'
  | 'connection'
  | 'storage'
  | 'terminal'
  | 'domains'
  | 'access'
  | 'jobs'
  | 'settings';

/**
 * The tab bar, as a handful of named groups rather than a flat row.
 *
 * An app grew to sixteen tabs and the row became a thing you scrolled sideways
 * and read twice to find anything on. A `tab` is a destination on its own; a
 * `group` is a labelled menu that related destinations live under, so the bar is
 * five things wide and the rest is one click down. The group's button wears the
 * name and icon of whichever child is open, so the bar always says where you are
 * rather than only which drawer you are in.
 *
 * A group's items are `clusters`, and a divider is drawn between them: inside
 * Config, "how it is wired" sits above "what it is made of", so the menu reads
 * as two thoughts rather than one long list.
 */
type Leaf = { tab: Tab; label: string; icon: LucideIcon };
type NavEntry =
  | { kind: 'tab'; tab: Tab; label: string; icon: LucideIcon }
  | { kind: 'group'; key: string; label: string; icon: LucideIcon; clusters: Leaf[][] };

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
  const drawer = useDrawerWidth();

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
  const isWordPress = service.source === 'image' && (service.image ?? '').startsWith('wordpress');
  const entries: NavEntry[] = isApp
    ? [
        { kind: 'tab', tab: 'overview', label: 'Overview', icon: LayoutDashboard },
        // The most-run app on earth gets house treatment, one obvious tab of it.
        ...((isWordPress
          ? [{ kind: 'tab', tab: 'wordpress', label: 'WordPress', icon: Wand2 }]
          : []) as NavEntry[]),
        {
          kind: 'group',
          key: 'activity',
          label: 'Activity',
          icon: Activity,
          clusters: [
            [
              { tab: 'logs', label: 'Logs', icon: ScrollText },
              { tab: 'deployments', label: 'Deploys', icon: Rocket },
              // Only image-run apps update this way; a repository app updates by deploying.
              ...((service.source === 'image'
                ? [{ tab: 'updates', label: 'Updates', icon: RefreshCw }]
                : []) as Leaf[]),
            ],
            [
              { tab: 'traffic', label: 'Visitors', icon: Users },
              { tab: 'metrics', label: 'Load', icon: Gauge },
            ],
            [{ tab: 'messages', label: 'Messages', icon: Inbox }],
          ],
        },
        {
          kind: 'group',
          key: 'config',
          label: 'Config',
          icon: SlidersHorizontal,
          clusters: [
            [
              { tab: 'variables', label: 'Variables', icon: Braces },
              { tab: 'connection', label: 'Connections', icon: Link2 },
              { tab: 'domains', label: 'Domains', icon: Globe },
            ],
            [
              { tab: 'storage', label: 'Storage', icon: HardDrive },
              { tab: 'access', label: 'Access', icon: Shield },
              { tab: 'jobs', label: 'Scheduled', icon: Clock },
            ],
          ],
        },
        {
          kind: 'group',
          key: 'tools',
          label: 'Tools',
          icon: Wrench,
          clusters: [
            [
              { tab: 'terminal', label: 'Terminal', icon: SquareTerminal },
              // One Files tab for everything: a dragged-in site's own source (edit
              // and publish), or an app's storage volumes, decided per app inside.
              { tab: 'files', label: 'Files', icon: FolderOpen },
            ],
          ],
        },
        { kind: 'tab', tab: 'settings', label: 'Settings', icon: SettingsIcon },
      ]
    : [
        // A database has few enough tabs to leave flat: grouping seven would add a
        // click to save a row that already fits.
        { kind: 'tab', tab: 'overview', label: 'Overview', icon: LayoutDashboard },
        { kind: 'tab', tab: 'browse', label: 'Browse', icon: Table2 },
        { kind: 'tab', tab: 'snapshots', label: 'Copies', icon: Copy },
        { kind: 'tab', tab: 'connection', label: 'Connection', icon: Link2 },
        { kind: 'tab', tab: 'variables', label: 'Variables', icon: Braces },
        { kind: 'tab', tab: 'terminal', label: 'Terminal', icon: SquareTerminal },
        { kind: 'tab', tab: 'settings', label: 'Settings', icon: SettingsIcon },
      ];

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="animate-overlay-in fixed inset-0 z-30 cursor-default bg-black/30"
        onClick={onClose}
      />
      <aside
        className="animate-drawer-in fixed inset-y-0 right-0 z-40 flex flex-col border-l border-line bg-surface shadow-[var(--d-shadow-pop)]"
        style={{ width: drawer.width, maxWidth: '100vw' }}
      >
        {/* The grip. Its hit area is wider than the line you can see, because a 2px
            target is a target you miss. */}
        {/* A div rather than a button: the ARIA window-splitter pattern is a focusable
            `separator` with a value, and putting that role on a button throws the
            button's own semantics away for a role it cannot legally have. */}
        {/* biome-ignore lint/a11y/useSemanticElements: the rule suggests <hr>, which
            cannot take focus and cannot hold the line you can see. A focusable
            separator carrying a value is the ARIA splitter pattern, and a div is the
            only element it fits on. */}
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize this panel"
          aria-valuenow={drawer.width}
          aria-valuemin={drawer.min}
          aria-valuemax={drawer.max}
          onPointerDown={drawer.onPointerDown}
          onKeyDown={drawer.onKeyDown}
          onDoubleClick={drawer.reset}
          title="Drag to resize. Double-click to reset"
          className={cx(
            'group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none',
            'focus-visible:outline-none',
          )}
        >
          <span
            className={cx(
              'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors',
              drawer.dragging
                ? 'bg-accent'
                : 'bg-transparent group-hover:bg-accent/50 group-focus-visible:bg-accent',
            )}
          />
        </div>

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
              className="mt-2.5 flex items-center gap-1.5 truncate text-[12px] text-accent hover:underline"
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

          <DrawerTabs entries={entries} active={tab} onSelect={setTab} />
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
          {tab === 'updates' && <UpdatesTab service={service} />}
          {tab === 'messages' && <MessagesTab service={service} />}
          {tab === 'variables' && <EnvEditor serviceId={service.id} />}
          {tab === 'connection' && <ConnectionTab service={service} />}
          {tab === 'storage' && <StorageTab service={service} />}
          {tab === 'terminal' && <TerminalTab service={service} />}
          {tab === 'domains' && <DomainsTab service={service} />}
          {tab === 'logs' && <LogsTab service={service} />}
          {tab === 'metrics' && <MetricsTab service={service} />}
          {tab === 'browse' && <BrowseTab service={service} />}
          {tab === 'snapshots' && <Snapshots service={service} />}
          {tab === 'files' && <FilesWorkspace service={service} />}
          {tab === 'wordpress' && <WordPressTab service={service} />}
          {tab === 'access' && <AccessTab service={service} />}
          {tab === 'jobs' && <JobsTab service={service} />}
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

/**
 * The grouped tab bar. A row of plain tabs and named menus; the open menu closes
 * on a pick or on a click anywhere else. A group whose child is showing wears
 * that child's name and the accent, so nothing about "where am I" hides behind a
 * label you have to open to read.
 */
function DrawerTabs({
  entries,
  active,
  onSelect,
}: {
  entries: NavEntry[];
  active: Tab;
  onSelect: (tab: Tab) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <nav className="-mb-px mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {entries.map((entry) => {
        if (entry.kind === 'tab') {
          const Icon = entry.icon;
          return (
            <button
              key={entry.tab}
              type="button"
              onClick={() => {
                setOpen(null);
                onSelect(entry.tab);
              }}
              className={cx(
                'flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 text-[13px] font-medium transition-colors',
                active === entry.tab
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {entry.label}
            </button>
          );
        }

        const activeItem = entry.clusters.flat().find((leaf) => leaf.tab === active);
        const isOpen = open === entry.key;
        // The button shows where you are: the open child's name and icon when one is
        // open, else the group's own.
        const ButtonIcon = activeItem ? activeItem.icon : entry.icon;
        return (
          <div key={entry.key} className="relative shrink-0">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : entry.key)}
              className={cx(
                'flex items-center gap-1.5 border-b-2 pb-2.5 text-[13px] font-medium transition-colors',
                activeItem
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              <ButtonIcon className="h-3.5 w-3.5" />
              {activeItem ? activeItem.label : entry.label}
              <ChevronDown
                className={cx('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-180')}
              />
            </button>

            {isOpen && (
              <>
                {/* Click-anywhere-else to dismiss, without stealing the click that
                    lands on another group's button. */}
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setOpen(null)}
                />
                <div
                  role="menu"
                  // The elevated-surface line token, not `border-line`: on this menu's
                  // `bg-elevated` the ordinary line is a shade the eye cannot separate
                  // from the background in dark mode, so the dividers disappeared.
                  className="absolute top-full left-0 z-50 mt-1 min-w-44 overflow-hidden rounded-[var(--radius-card)] border border-[color:var(--d-line-elevated)] bg-elevated py-1 shadow-[var(--d-shadow-pop)]"
                >
                  {entry.clusters.map((cluster, clusterIndex) => (
                    <div
                      // Clusters are fixed and ordered, so their position is their identity.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      key={clusterIndex}
                      className={cx(
                        clusterIndex > 0 &&
                          'mt-1 border-[color:var(--d-line-elevated)] border-t pt-1',
                      )}
                    >
                      {cluster.map((leaf) => {
                        const LeafIcon = leaf.icon;
                        const isActive = active === leaf.tab;
                        return (
                          <button
                            key={leaf.tab}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onSelect(leaf.tab);
                              setOpen(null);
                            }}
                            className={cx(
                              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
                              isActive
                                ? 'bg-accent/10 text-ink'
                                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                            )}
                          >
                            <LeafIcon
                              className={cx(
                                'h-3.5 w-3.5 shrink-0',
                                isActive ? 'text-accent' : 'text-ink-faint',
                              )}
                            />
                            {leaf.label}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </nav>
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
          {/* Offered rather than shown: reading the log is the right first move for
              anybody who can, and an opinion pushed in front of that is in the way. */}
          <div className="mt-3">
            <WhyBroken deploymentId={latest.id} />
          </div>
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

      {service.source === 'image' && <ShareAsTemplate service={service} />}
    </div>
  );
}

/**
 * This app, as a file somebody else can install.
 *
 * No `max-w-prose` on the text, unlike a documentation page. The drawer is already a
 * fixed column, so prose width does nothing except stop each paragraph at a different
 * place: two of them at 517 and 477 pixels inside a 740 pixel panel gave the block
 * three ragged right edges that lined up with nothing above it, and read as a mistake
 * rather than as a measure.
 *
 * Only offered for apps that run a published image, because that is the only kind a
 * template can describe: an app built from a repository is shared by sharing the
 * repository.
 *
 * The warning is not decoration. The person pressing this is about to publish the
 * file, and the file is generated from the app's own variables, which is exactly
 * where its secrets live. Derailed takes them out, but "we took the secrets out" is
 * a claim worth stating rather than assuming, so it says which ones and why.
 */
function ShareAsTemplate({ service }: { service: Service }) {
  return (
    <div className="border-t border-line pt-4">
      <p className="eyebrow mb-2">Share this app</p>
      <p className="mb-2.5 text-[13px] text-ink-muted">
        Downloads a template file. Anybody can paste its address into their own Derailed and get
        this app, with the same image, port, storage and database.
      </p>
      <p className="mb-3 text-[12px] text-ink-faint">
        Passwords, keys and tokens are left out: anything that came from your database becomes a
        placeholder, and anything that looks like a secret becomes a name their server fills in with
        a fresh random value. Read the file before publishing it.
      </p>
      <a className="btn-secondary" href={`/api/services/${service.id}/template`}>
        <Download className="h-3.5 w-3.5" />
        Download the template
      </a>
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
                  {/* Only worth saying when nobody pressed anything. A deploy that
                      appeared on its own is otherwise indistinguishable from one
                      somebody else started. */}
                  {deployment.trigger === 'release' && ' · a new release'}
                  {deployment.trigger === 'push' && ' · a push'}
                  {deployment.trigger === 'update' && ' · an update, backed up first'}
                  {deployment.trigger === 'auto-update' && ' · updated itself, backed up first'}
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
  const [builder, setBuilder] = useState(service.buildStrategy);
  const [dockerfileAt, setDockerfileAt] = useState(service.dockerfilePath ?? '');
  const [healthPath, setHealthPath] = useState(service.healthPath);
  const [healthCheck, setHealthCheck] = useState(service.healthCheck ?? 'http');
  const [healthExpect, setHealthExpect] = useState(service.healthExpect ?? '');
  const [healthCommand, setHealthCommand] = useState(service.healthCommand ?? '');
  const [memory, setMemory] = useState(service.memoryLimitMb ? String(service.memoryLimitMb) : '');
  const [autoDeploy, setAutoDeploy] = useState<AutoDeploy>(autoDeployOf(service));
  const [_confirm, _setConfirm] = useState('');
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
              ...(service.source === 'repo'
                ? {
                    buildStrategy: builder,
                    dockerfilePath:
                      builder === 'dockerfile' || builder === 'auto' ? dockerfileAt || null : null,
                  }
                : {}),
              healthPath: healthPath || '/',
              healthCheck,
              healthExpect: healthCheck === 'contains' ? healthExpect || null : null,
              healthCommand: healthCheck === 'command' ? healthCommand || null : null,
              deployOnRelease: autoDeploy === 'release',
              deployOnPush: autoDeploy === 'push',
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
            {service.source === 'repo' && (
              <div className="grid gap-3 sm:grid-cols-2">
                {/* The docs promised this control for two releases before it existed:
                    when detection guesses wrong, this is where the person says so. */}
                <label className="block">
                  <span className="label">Build it with</span>
                  <select
                    className="input"
                    value={builder}
                    onChange={(e) => setBuilder(e.target.value as typeof builder)}
                  >
                    <option value="auto">Whatever is detected</option>
                    <option value="dockerfile">Its own Dockerfile</option>
                    <option value="nixpacks">Build from source (Nixpacks)</option>
                    <option value="site">Plain website, no build</option>
                  </select>
                </label>
                {(builder === 'dockerfile' || builder === 'auto') && (
                  <label className="block">
                    <span className="label">Dockerfile</span>
                    <input
                      className="input"
                      value={dockerfileAt}
                      placeholder="Dockerfile"
                      onChange={(e) => setDockerfileAt(e.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
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
              {/* One dropdown, in the app's own language. It decides when a deploy
                  counts as working, and for 'contains' the uptime monitor holds the
                  live site to the same words. */}
              <label className="block">
                <span className="label">Healthy means</span>
                <select
                  className="input"
                  value={healthCheck}
                  onChange={(e) => setHealthCheck(e.target.value as typeof healthCheck)}
                >
                  <option value="http">It answers on its port</option>
                  <option value="contains">Its answer contains a text</option>
                  <option value="tcp">Its port accepts a connection</option>
                  <option value="command">A command inside it succeeds</option>
                  <option value="started">It keeps running</option>
                </select>
              </label>
            </div>
            {(healthCheck === 'http' || healthCheck === 'contains') && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="label">Health path</span>
                  <input
                    className="input"
                    value={healthPath}
                    onChange={(e) => setHealthPath(e.target.value)}
                  />
                </label>
                {healthCheck === 'contains' && (
                  <label className="block">
                    <span className="label">The answer must contain</span>
                    <input
                      className="input"
                      value={healthExpect}
                      placeholder="e.g. your site's name"
                      onChange={(e) => setHealthExpect(e.target.value)}
                    />
                  </label>
                )}
              </div>
            )}
            {healthCheck === 'command' && (
              <label className="block">
                <span className="label">The command that must succeed</span>
                <input
                  className="input font-mono text-[13px]"
                  value={healthCommand}
                  placeholder="e.g. redis-cli ping"
                  onChange={(e) => setHealthCommand(e.target.value)}
                />
              </label>
            )}
          </>
        )}

        {service.kind === 'app' && service.source === 'repo' && (
          <AutoDeployChoice service={service} value={autoDeploy} onChange={setAutoDeploy} />
        )}

        {service.kind === 'app' && <ImagesToggle service={service} />}

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

      {/* No type-the-name any more. That friction was protecting against destroying
          the data on the spot, which is no longer what this does: everything stored
          waits a week in the trash, and there is an Undo on the way out. */}
      {service.repoUrl && (
        <div className="border-t border-line pt-4">
          <p className="eyebrow mb-2">Branches</p>
          <PreviewBranches service={service} />
        </div>
      )}

      {service.kind === 'database' && <DbUpgradeCard service={service} />}

      <div className="rounded-lg border border-danger/30 p-4">
        <p className="text-sm font-semibold text-ink">Delete {service.name}</p>
        <p className="mt-1 text-sm text-ink-muted">
          This stops it and frees its web addresses.{' '}
          {service.kind === 'database'
            ? 'The database and everything in it is kept'
            : 'Anything it has stored is kept'}{' '}
          for a week, in the trash, in case you want it back.
        </p>
        <button
          type="button"
          className="btn-danger mt-3"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await endpoints.deleteService(service.id);
              await load();
              onClose();
              toastUndo(`${service.name} deleted.`, async () => {
                await endpoints.restoreFromTrash('service', service.id);
                await load();
              });
            } catch (err) {
              setError(err);
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />}
          Delete it
        </button>
      </div>
    </div>
  );
}

/**
 * Pictures the right size: one switch, one address shape to remember.
 *
 * Its own endpoint rather than part of the settings save, because turning it on
 * has a side effect (starting the shared resizer) that a batched save should not
 * quietly carry.
 */
function ImagesToggle({ service }: { service: Service }) {
  const [enabled, setEnabled] = useState(!!service.imgResize);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="rounded-[var(--radius-card)] border border-line p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">Pictures the right size</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Ask for <span className="font-mono">/_img/photo.jpg?w=800</span> and the picture comes
            back that wide, re-encoded, WebP for browsers that take it. Nothing about the site
            changes; the address is the whole feature.
          </p>
        </div>
        <Switch
          label=""
          checked={enabled}
          disabled={busy}
          onChange={(next) => {
            setBusy(true);
            setError(null);
            endpoints
              .setImages(service.id, next)
              .then(setEnabled)
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        />
      </div>
      <ErrorNote error={error} />
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
          className="input text-[12px]"
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

/**
 * Deploy when a new release is published.
 *
 * Only for repositories, and only GitHub ones, because that is where the releases
 * are being read from. Offering the switch anywhere else would be offering something
 * that quietly never fires.
 */
/** Off, on every push, or only on a published release. */
export type AutoDeploy = 'off' | 'push' | 'release';

export function autoDeployOf(service: Service): AutoDeploy {
  // Push wins if both are somehow set: it is the looser rule, so it is the one
  // actually in force, and showing "only on a release" would be a lie.
  if (service.deployOnPush) return 'push';
  return service.deployOnRelease ? 'release' : 'off';
}

/**
 * When Derailed should deploy this app by itself.
 *
 * One question with three answers rather than a switch per mechanism. They are not
 * independent in practice: deploying every push already covers deploying every
 * release, so two switches would offer a combination that means nothing and leave
 * people wondering which one wins.
 */
function AutoDeployChoice({
  service,
  value,
  onChange,
}: {
  service: Service;
  value: AutoDeploy;
  onChange: (next: AutoDeploy) => void;
}) {
  const fromRepo = service.source === 'repo' && !!service.repoUrl;
  const isGithub = /(^|\/\/|@)github\.com[/:]/i.test(service.repoUrl ?? '');
  const branch = service.branch ?? 'your branch';

  if (!fromRepo) {
    return (
      <div className="rounded-[var(--radius-card)] border border-line p-3.5">
        <p className="text-[13px] text-ink">Deploy automatically</p>
        <p className="mt-1 text-[12px] text-ink-muted">
          {service.source === 'upload'
            ? 'This app was made from files you dropped in, so there is no repository to watch. Drop a new zip on it to update it.'
            : 'This app runs a ready-made image, so there is no repository to watch. Updates to the image show up under Updates.'}
        </p>
      </div>
    );
  }

  const options: { value: AutoDeploy; label: string; hint: string; disabled?: boolean }[] = [
    {
      value: 'off',
      label: 'Only when I ask',
      hint: 'Nothing happens until you press Deploy.',
    },
    {
      value: 'push',
      label: `Every push to ${branch}`,
      hint:
        value === 'push' && service.lastPushedSha
          ? `Following on from ${service.lastPushedSha.slice(0, 7)}. New commits are built and deployed within about two minutes.`
          : 'Push your code and the running app catches up on its own, within about two minutes. What is running today is left alone, so choosing this does not redeploy anything now.',
    },
    {
      value: 'release',
      label: 'Only when I publish a release',
      hint: !isGithub
        ? 'Releases are a GitHub feature, and this app is not from a GitHub repository.'
        : value === 'release' && service.lastReleaseTag
          ? `Following on from ${service.lastReleaseTag}. The next release published on GitHub is deployed within about ten minutes.`
          : 'For when pushing and shipping are meant to be separate decisions. Tagging a release deploys it; ordinary commits are ignored.',
      disabled: !isGithub,
    },
  ];

  return (
    <div className="rounded-[var(--radius-card)] border border-line p-3.5">
      <p className="text-[13px] text-ink">Deploy automatically</p>
      <div className="mt-2.5 space-y-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 transition-colors',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
              value === option.value
                ? 'border-accent bg-accent-soft'
                : 'border-line hover:border-line-strong',
              option.disabled && 'pointer-events-none opacity-50',
            )}
          >
            {/* A real radio, so arrow keys, grouping and "selected" all work for a
                screen reader without any of it being written by hand. */}
            <input
              type="radio"
              name={`auto-deploy-${service.id}`}
              className="sr-only"
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span
              className={cx(
                'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                value === option.value ? 'border-accent bg-accent-solid' : 'border-line-strong',
              )}
            >
              {value === option.value && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{option.label}</span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-muted">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
