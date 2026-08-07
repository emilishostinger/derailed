import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui.tsx';

export interface ScopeOption {
  value: string;
  label: string;
  /** The heading this sits under. Options with no group come first, ungrouped. */
  group?: string;
  /** Shown on the right, dimmed. A count, a size, whatever the list is about. */
  meta?: string;
}

/**
 * Choosing one thing out of possibly hundreds.
 *
 * A row of buttons is fine for four things and is the wrong control for forty: it
 * wraps into a wall, the thing you want is somewhere in the middle of it, and finding
 * it means reading every label. That is what this replaces.
 *
 * So: one trigger showing the current choice, and a panel with a search box. Typing
 * filters across both the option and the group it is in, so "news" finds the Newsroom
 * project and everything in it. The list scrolls rather than growing, which is what
 * makes the hundredth app no worse than the third.
 *
 * `Select` is deliberately not reused. Its keyboard behaviour is a native select's,
 * where typing a letter jumps to the next option starting with it, and that is the
 * right behaviour for a short list of fixed choices and the wrong one the moment a
 * search box exists: the two would fight over every keystroke.
 */
export function ScopePicker({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: string;
  options: ScopeOption[];
  onChange: (next: string) => void;
  /** Said in front of the trigger, e.g. "Showing". */
  label?: string;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const id = useId();

  const current = options.find((option) => option.value === value);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.group ?? '').toLowerCase().includes(needle),
    );
  }, [options, query]);

  /** The visible list, with a heading inserted wherever the group changes. */
  const rows = useMemo(() => {
    const out: ({ kind: 'group'; label: string } | { kind: 'option'; option: ScopeOption })[] = [];
    let seen: string | undefined;
    for (const option of matches) {
      if (option.group && option.group !== seen) out.push({ kind: 'group', label: option.group });
      seen = option.group;
      out.push({ kind: 'option', option });
    }
    return out;
  }, [matches]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;

    // Measured after the panel exists, so one opened near the bottom of the window
    // goes upwards rather than hanging off the edge.
    const height = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - anchor.bottom;
    const flip = height > 0 && below < height + 8 && anchor.top > below;
    const width = Math.max(anchor.width, 260);

    setBox({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: flip ? anchor.top - height - 4 : anchor.bottom + 4,
      width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Scrolling the pane underneath would leave the panel behind, pointing at nothing.
    const shut = () => setOpen(false);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  // The highlight follows the filter. Without this, typing until one option is left
  // leaves the highlight on an index that no longer exists and Enter does nothing.
  useEffect(() => setActive(0), []);

  function choose(option?: ScopeOption) {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        setQuery('');
        trigger.current?.focus();
        break;
      case 'Enter':
        event.preventDefault();
        choose(matches[active]);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActive((at) => Math.min(at + 1, matches.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((at) => Math.max(at - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(matches.length - 1);
        break;
    }
  }

  return (
    <>
      <div className={cx('flex items-center gap-2', className)}>
        {label && <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>}
        <button
          ref={trigger}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="listbox"
          onClick={() => setOpen((was) => !was)}
          onKeyDown={(event) => {
            if (!open && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={cx(
            'input flex h-8 min-w-44 max-w-64 items-center justify-between gap-2 py-0 text-left text-[13px]',
            open && 'border-accent ring-[3px] ring-accent/20',
          )}
        >
          <span className="truncate">{current?.label ?? 'Everything'}</span>
          <ChevronDown
            className={cx(
              'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      </div>

      {open &&
        // Portalled for the same reason every other menu here is: `position: fixed`
        // stops meaning the viewport as soon as any ancestor has a transform, and the
        // panes these sit in animate in with one.
        createPortal(
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-[59] cursor-default"
              onClick={() => {
                setOpen(false);
                setQuery('');
              }}
            />
            <div
              ref={panel}
              id={id}
              className="panel animate-pop-in fixed z-[60] overflow-hidden"
              style={{
                left: box?.left ?? 0,
                top: box?.top ?? 0,
                width: box?.width ?? 0,
                visibility: box ? 'visible' : 'hidden',
              }}
            >
              {/* The search box only earns its space once there is enough to search. */}
              {options.length > 8 && (
                <div className="relative border-line border-b">
                  <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 text-ink-faint" />
                  <input
                    ref={field}
                    value={query}
                    placeholder="Search"
                    aria-label="Search"
                    className="w-full bg-transparent py-2 pr-2.5 pl-8 text-[13px] text-ink outline-none placeholder:text-ink-faint"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                  />
                </div>
              )}

              <div role="listbox" className="max-h-72 overflow-y-auto p-1">
                {rows.length === 0 ? (
                  <p className="px-2 py-3 text-[13px] text-ink-faint">Nothing matches that.</p>
                ) : (
                  rows.map((row) =>
                    row.kind === 'group' ? (
                      <p
                        key={`group:${row.label}`}
                        className="px-2 pt-2 pb-1 text-[11px] text-ink-faint"
                      >
                        {row.label}
                      </p>
                    ) : (
                      <button
                        key={row.option.value}
                        type="button"
                        role="option"
                        aria-selected={row.option.value === value}
                        onMouseEnter={() => setActive(matches.indexOf(row.option))}
                        onClick={() => choose(row.option)}
                        className={cx(
                          'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px] text-ink transition-colors',
                          matches[active]?.value === row.option.value && 'bg-surface-2',
                        )}
                      >
                        <Check
                          className={cx(
                            'h-3.5 w-3.5 shrink-0',
                            row.option.value === value ? 'text-accent' : 'text-transparent',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{row.option.label}</span>
                        {row.option.meta && (
                          <span className="shrink-0 text-[11px] text-ink-faint tabular">
                            {row.option.meta}
                          </span>
                        )}
                      </button>
                    ),
                  )
                )}
              </div>

              {/* Only once filtering is actually hiding something. */}
              {query.trim() && matches.length < options.length && (
                <p className="border-line border-t px-2.5 py-1.5 text-[11px] text-ink-faint">
                  {matches.length} of {options.length}
                </p>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
