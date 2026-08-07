import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 * Every menu on the page, so that opening one can shut the rest.
 *
 * Each menu owns its own state, which is right: a card should not have to know that
 * a sidebar row exists. But "only one menu is open at a time" is a fact about the
 * page, not about any one menu, so it lives here rather than in a shared parent that
 * would have to thread a callback through everything in between.
 */
const closers = new Set<() => void>();

/**
 * Right-click menus.
 *
 * Everything offered here is also reachable by clicking, because a menu that hides the
 * only route to something is a menu that half the people using it will never find.
 */
export function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);

  useEffect(() => {
    closers.add(close);
    return () => {
      closers.delete(close);
    };
  }, [close]);

  const open = useCallback(
    (event: React.MouseEvent, point: { x: number; y: number }) => {
      event.preventDefault();
      event.stopPropagation();
      for (const other of closers) if (other !== close) other();
      setAt(point);
    },
    [close],
  );

  return {
    at,
    /** True while this menu is showing, so its trigger can stay lit underneath it. */
    isOpen: at !== null,
    close,
    onContextMenu: (event: React.MouseEvent) => open(event, { x: event.clientX, y: event.clientY }),
    /**
     * The same menu, from a button rather than a right-click. Anchored to the
     * button's bottom-left so it hangs beneath it like a menu rather than appearing
     * wherever the pointer happened to be.
     */
    openFrom: (event: React.MouseEvent) => {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      open(event, { x: box.left, y: box.bottom + 4 });
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

  // Portalled for the same reason the dropdown is: `position: fixed` stops meaning
  // "the viewport" the moment any ancestor has a transform, and the modals and drawers
  // here animate in with one. A menu measured against the viewport and then positioned
  // against a dialog lands somewhere else entirely.
  return createPortal(
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
              // Every label is plain readable ink. Dimming the ones you are not on
              // makes the menu flicker as the pointer crosses it, and implies the
              // other items are unavailable when they are merely elsewhere.
              // Hovering moves a background, not a text colour.
              item.danger
                ? // Reads as an ordinary item until you are actually on it. A row that
                  // is red from the moment the menu opens shouts before it has been
                  // asked a question, and this menu is mostly ordinary items.
                  'text-ink hover:bg-danger-soft hover:text-danger'
                : 'text-ink hover:bg-surface-2',
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
    </div>,
    document.body,
  );
}
