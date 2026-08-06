import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from './ui.tsx';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/**
 * Right-click menus.
 *
 * Everything offered here is also reachable by clicking, because a menu that hides the
 * only route to something is a menu that half the people using it will never find.
 */
export function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  return {
    at,
    close: () => setAt(null),
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setAt({ x: event.clientX, y: event.clientY });
    },
  };
}

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  // Nudge it back on screen when opened near an edge, after it has been measured.
  useEffect(() => {
    if (!at || !menu.current) {
      setPosition(at);
      return;
    }
    const box = menu.current.getBoundingClientRect();
    setPosition({
      x: Math.min(at.x, window.innerWidth - box.width - 8),
      y: Math.min(at.y, window.innerHeight - box.height - 8),
    });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const dismiss = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    // `click` rather than `mousedown`, so the item's own click lands first.
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [at, onClose]);

  if (!at) return null;

  return (
    <div
      ref={menu}
      role="menu"
      className="panel animate-pop-in fixed z-[60] min-w-44 p-1"
      style={{ left: position?.x ?? at.x, top: position?.y ?? at.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.label}>
          {item.separated && <div className="my-1 border-t border-line" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className={cx(
              'group flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px] transition-colors',
              'disabled:pointer-events-none disabled:opacity-40',
              item.danger
                ? // Reads as an ordinary item until you are actually on it. A row that
                  // is red from the moment the menu opens shouts before it has been
                  // asked a question, and this menu is mostly ordinary items.
                  'text-ink-muted hover:bg-danger-soft hover:text-danger'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {/* The icon travels with the label, or half the row turns red and the
                other half does not. */}
            <span
              className={cx(
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-faint transition-colors',
                item.danger ? 'group-hover:text-danger' : 'group-hover:text-ink',
              )}
            >
              {item.icon}
            </span>
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
