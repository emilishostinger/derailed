import { schemas } from '@derailed/shared';
import {
  Activity,
  Archive,
  ArrowRight,
  ArrowUpCircle,
  Boxes,
  ChevronDown,
  ChevronsUpDown,
  Command,
  Database,
  Globe,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Plus,
  Settings2,
  ShieldAlert,
  Sun,
  Trash2,
  UserCog,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { ContextMenu, useContextMenu } from '../components/ContextMenu.tsx';
import { Wordmark } from '../components/Logo.tsx';
import { cx, ErrorNote, Modal, Spinner, StatusDot } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { useTheme } from '../stores/theme.ts';

export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
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
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full bg-canvas">
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      <MobileNav />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <InsecureNotice />
        <Outlet />
      </main>
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
        className="fixed top-3 left-3 z-30 rounded-[var(--radius-control)] border border-line bg-surface p-2 text-ink-muted shadow-[var(--d-shadow-card)] md:hidden"
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
            <MobileLink to="/updates" onGo={() => setOpen(false)}>
              Updates
            </MobileLink>
            <MobileLink to="/settings" onGo={() => setOpen(false)}>
              Settings
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

function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  // Remembered, because someone who folded the list away wants it folded away
  // tomorrow as well, and a preference that resets is worse than no preference.
  const [projectsOpen, setProjectsOpen] = useState(
    () => localStorage.getItem('derailed.projects-open') !== 'false',
  );

  useEffect(() => {
    localStorage.setItem('derailed.projects-open', String(projectsOpen));
  }, [projectsOpen]);

  const projects = useProjects((s) => s.projects);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface max-md:hidden">
      <div className="px-3 pt-4 pb-2">
        <NavLink to="/" className="block px-2 py-1">
          <Wordmark />
        </NavLink>
      </div>

      <button
        type="button"
        onClick={onOpenPalette}
        className="mx-3 mb-3 flex items-center gap-2 rounded-[var(--radius-control)] border border-line
          bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink-faint transition-colors
          hover:border-line-strong hover:text-ink-muted"
      >
        <Command className="h-3.5 w-3.5" />
        Jump to…
        <span className="kbd ml-auto">⌘K</span>
      </button>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        <NavItem
          to="/"
          icon={<Boxes className="h-4 w-4" />}
          end
          // Inside the row rather than beside it, so one highlight covers the whole
          // thing and the chevron is somewhere to aim at rather than a lone glyph.
          trailing={
            projects.length > 0 && (
              <button
                type="button"
                className="-mr-1 rounded-[4px] p-0.5 text-ink-faint transition-colors hover:text-ink"
                aria-label={projectsOpen ? 'Hide the project list' : 'Show the project list'}
                onClick={(event) => {
                  // The row is a link; the chevron is not a way of following it.
                  event.preventDefault();
                  event.stopPropagation();
                  setProjectsOpen((open) => !open);
                }}
              >
                <ChevronDown
                  className={cx('h-3.5 w-3.5 transition-transform', !projectsOpen && '-rotate-90')}
                />
              </button>
            )
          }
        >
          Projects
        </NavItem>

        {projectsOpen && projects.length > 0 && (
          <ul className="mt-1 mb-3 ml-2 space-y-px border-l border-line pl-2">
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
        <NavItem to="/server" icon={<Activity className="h-4 w-4" />}>
          Server
        </NavItem>
        <NavItem to="/backups" icon={<Archive className="h-4 w-4" />}>
          Backups
        </NavItem>
        <UpdatesNavItem />
        <NavItem to="/settings" icon={<Settings2 className="h-4 w-4" />}>
          Settings
        </NavItem>
      </nav>

      <SystemPanel />
      <ThemeToggle />
      <AccountMenu />
    </aside>
  );
}

function NavItem({
  to,
  icon,
  end,
  className,
  trailing,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  end?: boolean;
  className?: string;
  /** Sits at the right of the same row, inside the same highlight. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          className,
          'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-surface-2 text-ink'
            : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
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
            ? 'bg-surface-2 text-ink'
            : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
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
            urgent ? 'bg-warn text-black' : 'bg-surface-2 text-ink-muted',
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
  const navigate = useNavigate();
  const load = useProjects((s) => s.load);
  const status = aggregateStatus(services);
  const databases = services.filter((service) => service.kind === 'database').length;
  const menu = useContextMenu();
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  return (
    <>
      <NavLink
        onContextMenu={menu.onContextMenu}
        to={`/p/${slug}`}
        className={({ isActive }) =>
          cx(
            'group flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] transition-colors',
            isActive
              ? 'bg-surface-2 text-ink'
              : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
          )
        }
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {note ? (
          <span className="shrink-0 text-[11px] text-ink-faint">{note}</span>
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

      <ContextMenu
        at={menu.at}
        onClose={menu.close}
        items={[
          {
            label: 'Open',
            icon: <ArrowRight className="h-3.5 w-3.5" />,
            onSelect: () => navigate(`/p/${slug}`),
          },
          {
            label: 'Rename',
            icon: <Pencil className="h-3.5 w-3.5" />,
            onSelect: () => setDialog('rename'),
          },
          {
            label: 'Back it up',
            icon: <Archive className="h-3.5 w-3.5" />,
            separated: true,
            onSelect: async () => {
              setNote('Copying…');
              const ok = await endpoints
                .createBackup(id)
                .then(() => true)
                .catch(() => false);
              setNote(ok ? 'Copied' : 'Failed');
              setTimeout(() => setNote(null), 4000);
            },
          },
          {
            label: 'Delete',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            separated: true,
            onSelect: () => setDialog('delete'),
          },
        ]}
      />

      {dialog === 'rename' && (
        <RenameProject
          id={id}
          name={name}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await load();
          }}
        />
      )}

      {dialog === 'delete' && (
        <DeleteProject
          id={id}
          name={name}
          services={services.length}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await load();
            navigate('/');
          }}
        />
      )}
    </>
  );
}

function RenameProject({
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

function DeleteProject({
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
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <Modal title={`Delete ${name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] text-ink">
          This removes{' '}
          {services === 0 ? 'the project' : `all ${services} of its apps and databases`}, along with
          everything stored in them. It cannot be undone.
        </p>
        <p className="hint">
          If you might want any of it back, close this and back the project up first.
        </p>
        <label className="block">
          <span className="label">Type {name} to confirm</span>
          <input
            className="input"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || confirm !== name}
            onClick={async () => {
              setBusy(true);
              try {
                await endpoints.deleteProject(id);
                onDone();
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

/** The honest state of the machine, in five words or fewer. */
/**
 * What Derailed is, rather than what it is made of.
 *
 * This used to report the Docker version, whether the proxy was up and how much disk
 * was left: true, and none of it anyone's business on every screen. The Server page
 * covers all three. A broken Docker still shows here, because that one is not trivia,
 * it means nothing can run.
 */
function SystemPanel() {
  const system = useSession((s) => s.system);
  const broken = system && !system.dockerOk;

  return (
    <div className="space-y-1.5 border-t border-line px-4 py-3 text-[12px] text-ink-muted">
      {broken ? (
        <Link to="/server" className="flex items-center gap-2 text-warn hover:underline">
          <StatusDot status="failed" />
          <span className="truncate">Docker is unreachable</span>
        </Link>
      ) : (
        <>
          <p className="truncate">Derailed v{system?.version ?? '-'}</p>
          <a
            href="https://opensource.org/license/mit"
            target="_blank"
            rel="noreferrer"
            className="block truncate text-ink-faint transition-colors hover:text-ink-muted"
          >
            MIT licence, free forever
          </a>
        </>
      )}
    </div>
  );
}

/** Two states, both visible. A hidden toggle is one nobody finds. */
function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);

  return (
    <div className="flex gap-1 border-t border-line p-2">
      {(['dark', 'light'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setTheme(option)}
          className={cx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5 text-[12px] transition-colors',
            theme === option
              ? 'bg-surface-2 text-ink'
              : 'text-ink-faint hover:bg-surface-2/60 hover:text-ink-muted',
          )}
        >
          {option === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
          {option === 'dark' ? 'Dark' : 'Light'}
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
    <div ref={wrapper} className="relative border-t border-line p-2">
      {open && (
        <div className="panel animate-pop-in absolute bottom-full left-2 right-2 mb-1 overflow-hidden p-1">
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
          <p className="border-t border-line px-2 pt-2 pb-1 text-[11px] text-ink-faint tabular">
            Derailed v{system?.version ?? '-'}
            {system?.serverIp ? ` · ${system.serverIp}` : ''}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
          {(user?.email ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">{user?.email}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
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
          <span className="font-mono text-ink-muted">derailed reset-password</span> on the server.
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
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[15px] font-semibold text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-ink-faint">{subtitle}</p>}
      </div>
      {children}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
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
