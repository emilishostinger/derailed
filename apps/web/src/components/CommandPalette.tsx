import {
  Bot,
  Boxes,
  CornerDownLeft,
  Database,
  Globe,
  Moon,
  RotateCw,
  Search,
  Settings2,
  Sun,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useTheme } from '../stores/theme.ts';
import { cx, StatusDot } from './ui.tsx';

const GROUP_ORDER = ['Projects', 'Services', 'Domains', 'Actions', 'Navigate'];

interface Command {
  id: string;
  label: string;
  /** Shown to the right, where this goes or what it belongs to. */
  detail?: string;
  group: string;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * ⌘K. Everything reachable in the app is reachable from here in three keystrokes,
 * which is the whole point of building it.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const projects = useProjects((s) => s.projects);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [];

    for (const project of projects) {
      items.push({
        id: `project-${project.id}`,
        label: project.name,
        detail: `${(project.services ?? []).length} services`,
        group: 'Projects',
        icon: <Boxes className="h-4 w-4" />,
        run: () => navigate(`/p/${project.slug}`),
      });

      for (const service of project.services ?? []) {
        items.push({
          id: `service-${service.id}`,
          label: service.name,
          detail: project.name,
          group: 'Services',
          keywords: `${project.name} ${service.kind} ${service.dbEngine ?? ''}`,
          icon:
            service.kind === 'database' ? (
              <Database className="h-4 w-4" />
            ) : (
              <StatusDot status={service.status ?? 'stopped'} className="mx-0.5" />
            ),
          run: () => navigate(`/p/${project.slug}?service=${service.id}`),
        });

        if (service.kind === 'app') {
          items.push({
            id: `deploy-${service.id}`,
            label: `Deploy ${service.name}`,
            detail: project.name,
            group: 'Actions',
            keywords: 'redeploy build ship',
            icon: <RotateCw className="h-4 w-4" />,
            run: () => void endpoints.deploy(service.id).catch(() => undefined),
          });
        }

        for (const domain of service.domains ?? []) {
          items.push({
            id: `domain-${domain.id}`,
            label: domain.hostname,
            detail: 'Open in a new tab',
            group: 'Domains',
            icon: <Globe className="h-4 w-4" />,
            run: () =>
              window.open(
                `${domain.tlsStatus === 'active' ? 'https' : 'http'}://${domain.hostname}`,
                '_blank',
                'noreferrer',
              ),
          });
        }
      }
    }

    items.push(
      {
        id: 'go-projects',
        label: 'Go to projects',
        group: 'Navigate',
        icon: <Boxes className="h-4 w-4" />,
        run: () => navigate('/'),
      },
      {
        id: 'go-agents',
        label: 'Go to coding agents',
        group: 'Navigate',
        keywords: 'mcp agent claude cursor codex token editor',
        icon: <Bot className="h-4 w-4" />,
        run: () => navigate('/agents'),
      },
      {
        id: 'go-settings',
        label: 'Go to settings',
        group: 'Navigate',
        icon: <Settings2 className="h-4 w-4" />,
        run: () => navigate('/settings'),
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
        group: 'Navigate',
        keywords: 'theme dark light appearance',
        icon: theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
        run: () => toggleTheme(),
      },
    );

    return items;
  }, [projects, navigate, theme, toggleTheme]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? commands.filter((command) =>
          `${command.label} ${command.detail ?? ''} ${command.keywords ?? ''}`
            .toLowerCase()
            .includes(needle),
        )
      : commands;

    // Commands are built per service, so they arrive interleaved. Sorting into a
    // fixed group order is what stops the list repeating "Services / Actions".
    return [...filtered].sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
  }, [commands, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting the highlight is the point. It must react to the query, not to `active`.
  useEffect(() => setActive(0), [query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling follows the highlight, which is exactly `active`.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % Math.max(matches.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % Math.max(matches.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = matches[active];
      if (command) {
        command.run();
        onClose();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  // Render each group's heading the first time one of its members appears.
  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        className="animate-overlay-in fixed inset-0 cursor-default bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="panel animate-fade-up relative flex max-h-[60vh] w-full max-w-lg flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3.5">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          {/* Every key the palette cares about is typed into this input, so the
              handler belongs here rather than on a wrapper that never has focus. */}
          <input
            autoFocus
            onKeyDown={onKeyDown}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects, apps and commands…"
            className="w-full bg-transparent py-3.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className="kbd shrink-0">esc</span>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-ink-faint">
              Nothing matches “{query}”.
            </p>
          )}

          {matches.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {heading && <p className="eyebrow px-2.5 pt-3 pb-1.5">{heading}</p>}
                <button
                  type="button"
                  data-active={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => {
                    command.run();
                    onClose();
                  }}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] transition-colors',
                    index === active ? 'bg-surface-2 text-ink' : 'text-ink-muted',
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-faint">
                    {command.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.detail && (
                    <span className="shrink-0 truncate text-[12px] text-ink-faint">
                      {command.detail}
                    </span>
                  )}
                  {index === active && (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
