import { schemas } from '@derailed/shared';
import {
  Activity,
  Archive,
  ArrowUpCircle,
  BookOpen,
  Bot,
  Boxes,
  ChevronDown,
  ChevronLeft,
  Database,
  Globe,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings2,
  ShieldAlert,
  Sun,
  Trash2,
  UserCog,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { Confetti } from '../components/Celebrate.tsx';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { Wordmark } from '../components/Logo.tsx';
import { useProjectActions } from '../components/projectActions.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { cx, ErrorNote, Modal, Spinner, StatusDot } from '../components/ui.tsx';
import { useCelebration } from '../stores/celebration.ts';
import { usePalette } from '../stores/palette.ts';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { useTheme } from '../stores/theme.ts';
import { toastUndo } from '../stores/toasts.ts';

export function Layout() {
  const confetti = useCelebration((s) => s.confetti);
  const stopConfetti = useCelebration((s) => s.stop);
  const paletteOpen = usePalette((s) => s.open);
  const setPaletteOpen = usePalette((s) => s.setOpen);
  const togglePalette = usePalette((s) => s.toggle);
  const projectsLoaded = useProjects((s) => s.loaded);
  const loadProjects = useProjects((s) => s.load);

  // Loaded here rather than on the Projects page. Every page inside this shell shows
  // the project list in the sidebar, and opening a link straight to Backups used to
  // land on an empty one, which reads as "you have nothing" rather than "not yet".
  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette]);

  // The canvas is the background everything sits on. Only the main area is lifted
  // off it; the sidebar stays down on the canvas, which is what gives the contrast.
  return (
    <div className="flex h-full gap-2 bg-canvas p-2">
      <Sidebar />
      <MobileNav />
      <main className="shell flex min-w-0 flex-1 flex-col">
        <InsecureNotice />
        <Outlet />
      </main>
      <Toasts />
      {confetti && <Confetti onDone={stopConfetti} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

/**
 * Below `md` the sidebar is hidden, which previously left no navigation at all -
 * someone checking their site from a phone got a dead end.
 */
function MobileNav() {
  const projects = useProjects((s) => s.projects);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Menu"
        onClick={() => setOpen(true)}
        className="fixed top-4 left-4 z-30 rounded-[var(--radius-control)] border border-line bg-surface p-2 text-ink-muted shadow-[var(--d-shadow-card)] md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close"
            className="animate-overlay-in absolute inset-0 cursor-default bg-black/50"
            onClick={() => setOpen(false)}
          />
          <nav className="animate-drawer-in absolute inset-y-0 left-0 flex w-64 flex-col gap-1 border-r border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <Wordmark />
              <button type="button" className="btn-ghost px-1.5" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <MobileLink to="/" onGo={() => setOpen(false)}>
              Projects
            </MobileLink>
            {projects.map((project) => (
              <MobileLink
                key={project.id}
                to={`/p/${project.slug}`}
                onGo={() => setOpen(false)}
                indent
              >
                {project.name}
              </MobileLink>
            ))}
            <MobileLink to="/domains" onGo={() => setOpen(false)}>
              Domains
            </MobileLink>
            <MobileLink to="/server" onGo={() => setOpen(false)}>
              Server
            </MobileLink>
            <MobileLink to="/backups" onGo={() => setOpen(false)}>
              Backups
            </MobileLink>
            <MobileLink to="/trash" onGo={() => setOpen(false)}>
              Trash
            </MobileLink>
            <MobileLink to="/updates" onGo={() => setOpen(false)}>
              Updates
            </MobileLink>
            <MobileLink to="/agents" onGo={() => setOpen(false)}>
              Coding agents
            </MobileLink>
            <MobileLink to="/settings" onGo={() => setOpen(false)}>
              Settings
            </MobileLink>
            <MobileLink to="/help" onGo={() => setOpen(false)}>
              Handbook
            </MobileLink>

            <div className="mt-auto">
              <ThemeToggle />
              <div className="border-t border-line pt-2">
                <MobileSignOut />
              </div>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}

/** The mobile drawer had no way out, which is a strange thing to leave out. */
function MobileSignOut() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);

  return (
    <div className="space-y-1">
      <p className="truncate px-2 py-1 text-[12px] text-ink-faint">{user?.email}</p>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-2 text-left text-[14px] text-danger"
        onClick={() => void logout()}
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </div>
  );
}

function MobileLink({
  to,
  onGo,
  indent,
  children,
}: {
  to: string;
  onGo: () => void;
  indent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      onClick={onGo}
      end={to === '/'}
      className={({ isActive }) =>
        cx(
          'rounded-[var(--radius-control)] px-2 py-2 text-[14px] transition-colors',
          indent && 'ml-3 text-[13px]',
          isActive ? 'bg-surface-2 text-ink' : 'text-ink-muted',
        )
      }
    >
      {children}
    </NavLink>
  );
}

const DISMISSED = 'derailed.insecure-dismissed';

/**
 * You just typed a password into a page served over plain HTTP. Say so, once, at the
 * top of the app, Settings is too easy to never open.
 */
function InsecureNotice() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });

  const insecure =
    typeof window !== 'undefined' &&
    window.location.protocol === 'http:' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1';

  if (!insecure || dismissed) return null;

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-warn/30 bg-warn-soft px-5 py-2.5">
      <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[13px] text-ink">
        This dashboard isn't secure, your password was sent unencrypted.{' '}
        <Link to="/settings" className="font-medium text-accent hover:underline">
          Give it a domain
        </Link>{' '}
        and Derailed will switch it to HTTPS.
      </p>
      <button
        type="button"
        className="btn-ghost shrink-0 px-1.5"
        aria-label="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, '1');
          } catch {
            // Not persisting it just means they see it again, which is no tragedy.
          }
          setDismissed(true);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Sidebar() {
  // Remembered, because someone who folded the list away wants it folded away
  // tomorrow as well, and a preference that resets is worse than no preference.
  const [projectsOpen, setProjectsOpen] = useState(
    () => localStorage.getItem('derailed.projects-open') !== 'false',
  );

  useEffect(() => {
    localStorage.setItem('derailed.projects-open', String(projectsOpen));
  }, [projectsOpen]);

  const projects = useProjects((s) => s.projects);
  // Whether the Projects row currently leads anywhere. On the dashboard it does not,
  // which is what frees the click up to mean "fold this away".
  const onProjects = useLocation().pathname === '/';

  // Not a slab. It sits directly on the canvas, so the only thing raised off the
  // background is the work itself, and the navigation reads as part of the frame.
  return (
    <aside className="deep-surface flex w-60 shrink-0 flex-col max-md:hidden">
      {/* The theme control lives up here beside the mark, where there was empty space
          anyway, rather than competing with the address for the width of one row. */}
      <div className="flex items-center justify-between px-3 pt-4 pb-2">
        <NavLink to="/" className="block px-2 py-1">
          <Wordmark />
        </NavLink>
        <ThemeToggle />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pt-1 pb-3">
        {/* What you made. */}
        <NavGroup>
          <NavItem
            to="/"
            icon={<Boxes className="h-4 w-4" />}
            end
            aria-expanded={projects.length > 0 ? projectsOpen : undefined}
            // The whole row folds the list, not a 14-pixel glyph at the end of it. The
            // chevron stays as the thing that says which way it will go, but it is no
            // longer the only place you are allowed to hit.
            onClick={(event) => {
              // Leave modified clicks alone: cmd-click still opens a tab.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (projects.length === 0) return;
              if (onProjects) {
                // Already here, so the click has nowhere to take you and can mean the
                // only other thing it could mean. Clicking again puts it back.
                event.preventDefault();
                setProjectsOpen((open) => !open);
              } else {
                // Arriving from elsewhere: go, and show the list you came to see.
                setProjectsOpen(true);
              }
            }}
            trailing={
              projects.length > 0 && (
                <ChevronDown
                  aria-hidden="true"
                  className={cx(
                    '-mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform',
                    !projectsOpen && '-rotate-90',
                  )}
                />
              )
            }
          >
            Projects
          </NavItem>

          {projectsOpen && projects.length > 0 && (
            <ul className="mt-1 mb-1 ml-2 space-y-px border-l border-line pl-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <ProjectItem
                    id={project.id}
                    slug={project.slug}
                    name={project.name}
                    services={project.services ?? []}
                    backedUp={project.backupSchedule !== 'off'}
                  />
                </li>
              ))}
            </ul>
          )}

          <NavItem to="/domains" icon={<Globe className="h-4 w-4" />}>
            Domains
          </NavItem>
        </NavGroup>

        {/* The machine underneath it. */}
        <NavGroup label="Your server">
          <NavItem to="/server" icon={<Activity className="h-4 w-4" />}>
            Server
          </NavItem>
          <NavItem to="/backups" icon={<Archive className="h-4 w-4" />}>
            Backups
          </NavItem>
          <NavItem to="/trash" icon={<Trash2 className="h-4 w-4" />}>
            Trash
          </NavItem>
          <UpdatesNavItem />
        </NavGroup>

        {/* Things you set up once. */}
        <NavGroup label="Setup">
          <NavItem to="/agents" icon={<Bot className="h-4 w-4" />}>
            Coding agents
          </NavItem>
          <NavItem to="/settings" icon={<Settings2 className="h-4 w-4" />}>
            Settings
          </NavItem>
          {/* Last, and always there. The answer to "what does this actually do to my
              data" should not live in a repository nobody opens. */}
          <NavItem to="/help" icon={<BookOpen className="h-4 w-4" />}>
            Handbook
          </NavItem>
        </NavGroup>
      </nav>

      <BrokenDockerNotice />
      <AccountMenu />
    </aside>
  );
}

/**
 * A run of related destinations.
 *
 * Six items in one column is a list you read from the top every time. Split into what
 * you made, the machine under it, and what you set up once, it becomes three short
 * lists you can aim at. The first has no heading: it is where you already are.
 */
function NavGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      {label && <p className="eyebrow px-2 pt-1 pb-1.5">{label}</p>}
      {children}
    </div>
  );
}

function NavItem({
  to,
  icon,
  end,
  className,
  trailing,
  onClick,
  children,
  ...rest
}: {
  to: string;
  icon: React.ReactNode;
  end?: boolean;
  className?: string;
  /** Sits at the right of the same row, inside the same highlight. */
  trailing?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  children: React.ReactNode;
} & React.AriaAttributes) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      {...rest}
      className={({ isActive }) =>
        cx(
          className,
          'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-on-canvas-strong text-ink'
            : 'text-ink-muted hover:bg-on-canvas hover:text-ink',
        )
      }
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </NavLink>
  );
}

/**
 * Checked once when the dashboard loads, and shown as a dot rather than a number,
 * because "there is something to look at" is the whole message.
 */
function UpdatesNavItem() {
  const [pending, setPending] = useState(0);
  const [urgent, setUrgent] = useState(false);

  useEffect(() => {
    endpoints
      .updates()
      .then((report) => {
        setPending(report.items.length + (report.rebootRequired ? 1 : 0));
        setUrgent(report.items.some((item) => item.security) || report.rebootRequired);
      })
      .catch(() => undefined);
  }, []);

  return (
    <NavLink
      to="/updates"
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-on-canvas-strong text-ink'
            : 'text-ink-muted hover:bg-on-canvas hover:text-ink',
        )
      }
    >
      <span className="shrink-0 text-ink-faint">
        <ArrowUpCircle className="h-4 w-4" />
      </span>
      Updates
      {pending > 0 && (
        <span
          className={cx(
            'ml-auto flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
            urgent ? 'bg-warn text-black' : 'bg-on-canvas-strong text-ink-muted',
          )}
        >
          {pending}
        </span>
      )}
    </NavLink>
  );
}

/** A project in the sidebar tree, with a dot summarising everything inside it. */
function ProjectItem({
  id,
  slug,
  name,
  services,
  backedUp,
}: {
  id: string;
  slug: string;
  name: string;
  services: { status?: string | null; kind: string }[];
  backedUp?: boolean;
}) {
  const status = aggregateStatus(services);
  const databases = services.filter((service) => service.kind === 'database').length;
  const actions = useProjectActions({
    id,
    name,
    slug,
    services: services.length,
    includeOpen: true,
  });

  return (
    <>
      <NavLink
        onContextMenu={actions.onContextMenu}
        to={`/p/${slug}`}
        className={({ isActive }) =>
          cx(
            'group flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] transition-colors',
            isActive
              ? 'bg-on-canvas-strong text-ink'
              : cx(
                  'text-ink-muted hover:bg-on-canvas hover:text-ink',
                  actions.isOpen && 'bg-on-canvas text-ink',
                ),
          )
        }
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {actions.note ? (
          <span className="shrink-0 text-[11px] text-ink-faint">{actions.note}</span>
        ) : (
          <>
            {/* Only for the ones that are backed up: a mark on every row is noise. */}
            {backedUp && (
              <Archive
                className="h-3 w-3 shrink-0 text-ink-faint"
                aria-label="Backed up automatically"
              />
            )}
            {databases > 0 && (
              <Database
                className="h-3 w-3 shrink-0 text-ink-faint"
                aria-label={`${databases} database`}
              />
            )}
          </>
        )}
      </NavLink>

      {actions.element}
    </>
  );
}

export function RenameProject({
  id,
  name,
  onClose,
  onDone,
}: {
  id: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <Modal title="Rename this project" onClose={onClose}>
      <div className="space-y-4">
        <label className="block">
          <span className="label">Name</span>
          <input
            className="input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="hint">
          The web address stays as it is, so nothing you have shared will break.
        </p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !value.trim() || value === name}
            onClick={async () => {
              setBusy(true);
              try {
                await endpoints.renameProject(id, value.trim());
                onDone();
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            Rename
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteProject({
  id,
  name,
  services,
  onClose,
  onDone,
}: {
  id: string;
  name: string;
  services: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // No "type the name to confirm" any more. That was the right friction when this
  // destroyed the data on the spot; now that the project waits a week in the trash
  // with everything it stored, making people copy out a name is friction protecting
  // against something that no longer happens.
  return (
    <Modal title={`Delete ${name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] text-ink">
          This stops {services === 0 ? 'the project' : `all ${services} of its apps and databases`}{' '}
          and frees its web addresses.
        </p>
        <p className="hint">
          Nothing stored is deleted yet. It waits in the trash for a week, so you can put it back if
          you change your mind.
        </p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await endpoints.deleteProject(id);
                onDone();
                // The offer to take it back, for the ten seconds in which anyone
                // realises they did not mean it. The trash keeps it for a week either
                // way; this is just the version that needs no navigating to.
                toastUndo(`${name} deleted.`, async () => {
                  await endpoints.restoreFromTrash('project', id);
                  await useProjects.getState().load();
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
    </Modal>
  );
}

/**
 * Docker being unreachable means nothing on this machine can run, so it is worth a
 * permanent line in the sidebar. Nothing else down here was: the version and the
 * licence took a block each, every screen, for two facts you look up once. Both moved
 * into the account menu, which is where you go when you want to know about the
 * install rather than about your apps.
 */
function BrokenDockerNotice() {
  const system = useSession((s) => s.system);
  if (!system || system.dockerOk) return null;

  return (
    <Link
      to="/server"
      className="mx-2 mb-1 flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-[12px] text-warn transition-colors hover:bg-on-canvas"
    >
      <StatusDot status="failed" />
      <span className="truncate">Docker is unreachable</span>
    </Link>
  );
}

/**
 * Both states still visible, because a hidden toggle is one nobody finds, but as two
 * icons in the corner of the account row rather than a full-width block of its own.
 */
function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] bg-on-canvas p-0.5">
      {(['dark', 'light'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-label={option === 'dark' ? 'Dark theme' : 'Light theme'}
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
          className={cx(
            'flex h-6 w-6 items-center justify-center rounded-[5px] transition-colors',
            theme === option
              ? 'on-surface bg-surface text-ink shadow-[var(--d-shadow-card)]'
              : 'text-ink-faint hover:text-ink-muted',
          )}
        >
          {option === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </button>
      ))}
    </div>
  );
}

function AccountMenu() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const system = useSession((s) => s.system);
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative flex items-center gap-1.5 p-2">
      {open && (
        <div className="panel animate-pop-in absolute right-2 bottom-full left-2 mb-1 overflow-hidden p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={() => {
              setOpen(false);
              setAccount(true);
            }}
          >
            <UserCog className="h-4 w-4" />
            Email and password
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={() => void logout()}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <div className="mt-1 border-t border-line px-2 pt-2 pb-1">
            <p className="text-[11px] text-ink-faint tabular">Derailed v{system?.version ?? '-'}</p>
            <a
              href="https://opensource.org/license/mit"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-ink-faint transition-colors hover:text-ink-muted"
            >
              MIT licence, free forever
            </a>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors hover:bg-on-canvas"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
          {(user?.email ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted" title={user?.email}>
          {user?.email}
        </span>
      </button>

      {account && <AccountDialog onClose={() => setAccount(false)} />}
    </div>
  );
}

/**
 * Changing the address you sign in with, or the password.
 *
 * Both ask for the current password. The session in this browser is already trusted,
 * but an unattended screen should not be enough to move someone's account.
 */
function AccountDialog({ onClose }: { onClose: () => void }) {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [email, setEmail] = useState(user?.email ?? '');
  const [emailPassword, setEmailPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<'email' | 'password' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function saveEmail() {
    setBusy('email');
    setError(null);
    setNote(null);
    try {
      const { user: updated } = await endpoints.changeEmail(email.trim(), emailPassword);
      setUser(updated);
      setEmailPassword('');
      setNote('That is the address you sign in with now.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function savePassword() {
    setBusy('password');
    setError(null);
    setNote(null);
    try {
      await endpoints.changePassword(current, next);
      setCurrent('');
      setNext('');
      setNote('Password changed. Anywhere else you were signed in has been signed out.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Email and password" onClose={onClose}>
      <div className="space-y-6">
        <section className="space-y-3">
          <p className="eyebrow">Email</p>
          <label className="block">
            <span className="label">Address</span>
            <input
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Your password, to confirm</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={emailPassword}
              onChange={(event) => setEmailPassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || !email.trim() || !emailPassword || email === user?.email}
            onClick={() => void saveEmail()}
          >
            {busy === 'email' && <Spinner />}
            Change the email
          </button>
        </section>

        <section className="space-y-3 border-t border-line pt-5">
          <p className="eyebrow">Password</p>
          <label className="block">
            <span className="label">Current password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">New password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <span className="hint mt-1 block">
              Ten characters or more. A short phrase you can remember beats a clever one you cannot.
            </span>
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || !current || next.length < schemas.MIN_PASSWORD_LENGTH}
            onClick={() => void savePassword()}
          >
            {busy === 'password' && <Spinner />}
            Change the password
          </button>
        </section>

        {note && <p className="text-[12px] text-ok">{note}</p>}
        <ErrorNote error={error} />

        <p className="hint">
          Locked out with no way back in? Run{' '}
          <span className="text-ink-muted">derailed reset-password</span> on the server.
        </p>
      </div>
    </Modal>
  );
}

/**
 * A page header that sits flush under the top of the content area. Every page
 * uses it so the app has one consistent horizon line.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5 max-md:pl-14">
      {/* Three columns of equal weight rather than a centred element positioned
          absolutely. Absolute centring puts the bar under a long project name or a
          wide pair of buttons at some window size nobody tested; this cannot, and
          the sides truncate instead. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <BackButton />
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate text-[15px] font-semibold text-ink">{title}</h1>
          {subtitle && <p className="truncate text-[13px] text-ink-faint">{subtitle}</p>}
        </div>
        {children}
      </div>

      <CommandBar />

      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{actions}</div>
    </header>
  );
}

/**
 * The way into the command palette, in the middle of the top of the page.
 *
 * It used to sit in the sidebar, which is where a navigation tree goes rather than
 * where a search box does. Up here it reads as the thing you type into to get
 * anywhere, which is what it is.
 *
 * Hidden below `md`, where the sidebar is a drawer and there is no room for it. The
 * keyboard shortcut still works, and nothing here is only reachable through it.
 */
function CommandBar() {
  const openPalette = usePalette((s) => s.setOpen);

  return (
    <button
      type="button"
      onClick={() => openPalette(true)}
      className="hidden h-8 w-full max-w-sm shrink items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-2.5 text-[13px] text-ink-faint transition-colors hover:border-line-strong hover:text-ink-muted md:flex"
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Jump to a project, a domain, anything</span>
      <span className="kbd ml-auto shrink-0">⌘K</span>
    </button>
  );
}

/**
 * Back, in the corner every application puts it in.
 *
 * Only when there is somewhere to go. React Router keeps an index on the history
 * entry it owns, so a page opened directly, or the first one after a sign-in, knows
 * it is the beginning and does not offer to leave. `history.length` cannot answer
 * this: it counts the whole tab, including whatever was open before this app was.
 */
function BackButton() {
  const navigate = useNavigate();
  // Read on every navigation, because the index changes underneath us.
  const location = useLocation();
  const index =
    typeof window === 'undefined'
      ? 0
      : ((window.history.state as { idx?: number } | null)?.idx ?? 0);

  if (index <= 0) return null;

  return (
    <button
      key={location.key}
      type="button"
      aria-label="Back"
      title="Back"
      className="-ml-2 shrink-0 rounded-[var(--radius-control)] p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
      onClick={() => navigate(-1)}
    >
      <ChevronLeft className="h-4 w-4" />
    </button>
  );
}

/** The "+ New" button styling every page shares. */
export function NewButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="btn-primary" onClick={onClick}>
      <Plus className="h-4 w-4" />
      {label}
    </button>
  );
}

function aggregateStatus(services: { status?: string | null }[]): string {
  if (services.length === 0) return 'off';
  const statuses = services.map((service) => service.status ?? 'stopped');
  if (statuses.some((status) => status === 'failed' || status === 'crashed')) return 'failed';
  if (statuses.some((status) => status === 'deploying' || status === 'creating'))
    return 'deploying';
  if (statuses.every((status) => status === 'running')) return 'running';
  return 'stopped';
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
