import { AlertCircle, Check, ChevronDown, ChevronLeft, Copy } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client.ts';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Shows an error the way the product talks: what happened, then what to do. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof ApiError ? error.hint : undefined;
  return (
    <div className="flex gap-2.5 rounded-[var(--radius-card)] border border-danger/25 bg-danger-soft px-3.5 py-3 text-[13px]">
      <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="text-ink">{message}</p>
        {hint && <p className="mt-1 text-ink-muted">{hint}</p>}
      </div>
    </div>
  );
}

export function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        opacity="0.2"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FullPageLoader() {
  return (
    <div className="flex h-full items-center justify-center text-ink-faint">
      <Spinner className="h-5 w-5" />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-ink-muted">{hint}</span>}
    </label>
  );
}

/**
 * An on/off setting, with its explanation attached.
 *
 * A checkbox and a sentence beside it would do the same job, but a setting that
 * changes what the server does on its own deserves to look like a switch rather than
 * like one more field in a form.
 */
export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cx('flex gap-3', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors',
          'disabled:pointer-events-none',
          checked ? 'border-accent-solid bg-accent-solid' : 'border-line-strong bg-sunken',
        )}
      >
        <span
          className={cx(
            'block h-3.5 w-3.5 rounded-full transition-transform',
            checked ? 'translate-x-[15px] bg-accent-ink' : 'translate-x-[1px] bg-ink-faint',
          )}
        />
      </button>
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * An expanding section that unfolds instead of appearing.
 *
 * The grid trick rather than a measured height: a grid row animates cleanly from `0fr`
 * to `1fr`, so the content decides its own height and nothing has to be measured in
 * JavaScript, re-measured when it changes, or hardcoded and then wrong. The rule
 * itself lives in `styles.css`, because `transition-[a,b]` does not survive Tailwind's
 * arbitrary-value parser and quietly produced a panel that snapped.
 *
 * Kept deliberately short and small. The point is a hint that something unfolded from
 * the row you pressed, not a performance: a long ease on every panel in an app is the
 * thing that makes software feel slow rather than smooth, and it is worse the tenth
 * time you see it than the first.
 *
 * Nothing is needed for reduced motion here. The global rule in `styles.css` already
 * flattens every transition in the app for anybody who has asked for that.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="reveal" data-open={open}>
      <div>{children}</div>
    </div>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A line of explanation under the label, for choices that need one. */
  hint?: string;
}

/**
 * A dropdown that looks like the rest of the app.
 *
 * A native `<select>` is the one control a browser refuses to let you style. Its list
 * is drawn by the operating system, so on a dark dashboard it opens a bright white
 * menu in a different typeface with different corners, and on every platform it is a
 * different shape. Next to controls that were designed, it reads as something that was
 * forgotten.
 *
 * So the list is drawn here. The parts a native select gets right and hand-rolled ones
 * usually drop are kept deliberately: it is a real listbox to a screen reader, the
 * keyboard works the way the platform one does, and typing jumps to a matching option.
 *
 * The panel is positioned `fixed` rather than absolutely inside the trigger. These sit
 * in scrolling panes and inside modals, and an absolutely positioned menu gets clipped
 * by the first ancestor with `overflow` on it, which is a bug that only shows up in the
 * one place somebody actually uses the control.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
  className,
  placeholder = 'Pick one…',
  ariaLabel,
}: {
  value: T | '';
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  const selected = options.findIndex((option) => option.value === value);
  const current = selected >= 0 ? options[selected] : undefined;
  const id = useId();

  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;

    // Measured after the list exists, so a menu near the bottom of the window opens
    // upwards instead of hanging off the edge.
    const height = list.current?.offsetHeight ?? 0;
    const below = window.innerHeight - anchor.bottom;
    const flip = height > 0 && below < height + 8 && anchor.top > below;

    // And kept on screen sideways. These are often wider than the control that opened
    // them, because the options carry a line of explanation and the control is a
    // narrow column in a row. Anchoring the left edge and hoping is how a menu ends up
    // half off the right of the window on a laptop.
    const width = list.current?.offsetWidth ?? anchor.width;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));

    setBox({
      left,
      top: flip ? anchor.top - height - 4 : anchor.bottom + 4,
      width: anchor.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const shut = () => setOpen(false);
    // Scrolling the pane underneath would leave the menu behind, pointing at nothing.
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function show() {
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  }

  /** The keys a native select answers to, because muscle memory is the whole point. */
  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActive((at) => Math.min(at + 1, options.length - 1));
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
        setActive(options.length - 1);
        break;
      default: {
        // Typeahead. A list of database versions is exactly where somebody types "16"
        // rather than reaching for the mouse.
        if (event.key.length !== 1) return;
        const from = options.findIndex((option, index) =>
          index > active ? option.label.toLowerCase().startsWith(event.key.toLowerCase()) : false,
        );
        const wrapped =
          from >= 0
            ? from
            : options.findIndex((option) =>
                option.label.toLowerCase().startsWith(event.key.toLowerCase()),
              );
        if (wrapped >= 0) setActive(wrapped);
      }
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
        onKeyDown={onKeyDown}
        onClick={() => (open ? setOpen(false) : show())}
        className={cx(
          'input flex items-center justify-between gap-2 text-left',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-accent ring-[3px] ring-accent/20',
          className,
        )}
      >
        <span className={cx('truncate', !current && 'text-ink-faint')}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cx(
            'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {open &&
        // Rendered at the top of the document rather than beside the trigger.
        //
        // `position: fixed` is relative to the viewport only until some ancestor has a
        // transform on it, at which point that ancestor silently becomes the containing
        // block instead. Modals here animate in with `fade-up`, which is a transform,
        // and `fill-mode: both` means it keeps one after the animation ends. So a
        // dropdown opened inside a modal was measured against the viewport and then
        // positioned against the dialog, and landed somewhere off to the right.
        //
        // A portal is the only fix that stays fixed: nothing above it can move it.
        createPortal(
          <>
            {/* Clicking anywhere else puts it away, which is what everybody tries first. */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-[59] cursor-default"
              onClick={() => setOpen(false)}
            />
            <div
              ref={list}
              id={id}
              role="listbox"
              aria-label={ariaLabel}
              // A ceiling on the width, so one wordy option cannot stretch the menu
              // across the window. Narrow enough to sit under the control it belongs
              // to, wide enough that the explanations still read as sentences.
              className="panel animate-pop-in fixed z-[60] max-h-64 max-w-[min(22rem,calc(100vw-1rem))] overflow-y-auto p-1"
              style={{
                left: box?.left ?? 0,
                top: box?.top ?? 0,
                minWidth: box?.width ?? 0,
                // Hidden until measured, or it flashes in the wrong place first.
                visibility: box ? 'visible' : 'hidden',
              }}
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                  className={cx(
                    'flex w-full items-start gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px] text-ink transition-colors',
                    index === active && 'bg-surface-2',
                  )}
                >
                  <Check
                    className={cx(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      option.value === value ? 'text-accent' : 'text-transparent',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{option.label}</span>
                    {option.hint && (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">{option.hint}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

const STATUS_STYLES: Record<
  string,
  { dot: string; text: string; label: string; active?: boolean }
> = {
  running: { dot: 'bg-ok', text: 'text-ok', label: 'Running' },
  deploying: { dot: 'bg-busy', text: 'text-busy', label: 'Deploying', active: true },
  creating: { dot: 'bg-busy', text: 'text-busy', label: 'Setting up', active: true },
  stopped: { dot: 'bg-ink-faint', text: 'text-ink-muted', label: 'Stopped' },
  failed: { dot: 'bg-danger', text: 'text-danger', label: 'Failed' },
  crashed: { dot: 'bg-danger', text: 'text-danger', label: 'Crashed' },
  ok: { dot: 'bg-ok', text: 'text-ok', label: 'OK' },
  off: { dot: 'bg-ink-faint', text: 'text-ink-muted', label: 'Empty' },
};

function styleFor(status: string) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.stopped!;
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const style = styleFor(status);
  return (
    <span className={cx('relative inline-flex h-2 w-2 shrink-0', className)}>
      {/* A halo only while something is genuinely in motion, so movement means something. */}
      {style.active && (
        <span
          className={cx('animate-ping-ring absolute inset-0 rounded-full', style.dot)}
          aria-hidden="true"
        />
      )}
      <span
        className={cx(
          'relative inline-block h-2 w-2 rounded-full',
          style.dot,
          style.active && 'animate-status-pulse',
        )}
      />
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const style = styleFor(status);
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[12px] font-medium',
        style.text,
      )}
    >
      <StatusDot status={status} />
      {style.label}
    </span>
  );
}

/** Copy-to-clipboard that confirms itself in place rather than with a toast. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cx('btn-ghost px-1.5', className)}
      title={`Copy ${label ?? 'to clipboard'}`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      {label && <span className="text-[12px]">{copied ? 'Copied' : label}</span>}
    </button>
  );
}

/** The one empty-state shape, so every "nothing here yet" reads the same. */
export function EmptyState({
  icon,
  unframedIcon,
  title,
  body,
  action,
  note,
}: {
  icon: ReactNode;
  /**
   * The icon is usually one glyph, which wants a frame around it to read as a
   * subject rather than a stray mark. Set this when the icon is already a composed
   * thing, a row of brand tiles say, and the box would just be a box around a box.
   */
  unframedIcon?: boolean;
  title: string;
  body: string;
  action?: ReactNode;
  /**
   * A quieter aside, below the action. It belongs in here rather than after the empty
   * state: left outside, it kept the page's own alignment and full width while
   * everything above it was centred and held to a narrower measure, so it read as a
   * stray sentence sitting off to one side rather than the last line of this column.
   */
  note?: string;
}) {
  return (
    <div className="relative flex h-full min-h-[420px] flex-col items-center justify-center overflow-hidden px-6 py-16 text-center">
      <div className="rails pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative flex flex-col items-center">
        {unframedIcon ? (
          <span className="mb-4 flex items-center justify-center">{icon}</span>
        ) : (
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface text-ink-faint">
            {icon}
          </span>
        )}
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="mt-1.5 max-w-sm text-[13px] text-ink-muted">{body}</p>
        {action && <div className="mt-5">{action}</div>}
        {note && <p className="mt-6 max-w-sm text-[12px] text-ink-faint">{note}</p>}
      </div>
    </div>
  );
}

/** A centred dialog. Closes on backdrop click and on Escape. */
export function Modal({
  title,
  subtitle,
  onClose,
  onBack,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** When set, a back control sits in the header's top-left. For step-wise modals,
   *  where a "Back" floating above the body read as part of the content rather than
   *  as navigation. */
  onBack?: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-[8vh]">
      <button
        type="button"
        aria-label="Close"
        className="animate-overlay-in fixed inset-0 cursor-default bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('panel animate-fade-up relative w-full', wide ? 'max-w-2xl' : 'max-w-md')}
      >
        <div className="flex items-start gap-2.5 border-b border-line px-5 py-4">
          {onBack && (
            <button
              type="button"
              aria-label="Back"
              title="Back"
              className="btn-ghost -ml-2 mt-px shrink-0 px-1.5"
              onClick={onBack}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
          </div>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * A small history chart.
 *
 * `max` matters more than it looks. Scaling to the data's own maximum makes an idle
 * server at 1% draw the same dramatic peaks as a struggling one at 90%, which is worse
 * than showing nothing. Pass 100 for percentages so the shape means something.
 */
export function Sparkline({
  values,
  className = 'h-6 w-16',
  max,
  filled,
}: {
  values: number[];
  className?: string;
  max?: number;
  filled?: boolean;
}) {
  if (values.length < 2) {
    return (
      <div className={cx('flex items-center justify-center', className)} aria-hidden="true">
        <span className="h-px w-full bg-current opacity-20" />
      </div>
    );
  }

  const ceiling = max ?? Math.max(...values, 1);
  const at = (value: number) => 100 - Math.min(100, (value / ceiling) * 100);
  const step = 100 / (values.length - 1);
  const points = values.map(
    (value, index) => `${(index * step).toFixed(2)},${at(value).toFixed(2)}`,
  );

  return (
    <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {filled && (
        <polygon points={`0,100 ${points.join(' ')} 100,100`} fill="currentColor" opacity="0.14" />
      )}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A row of page-level tabs, for screens that had grown into one long scroll of
 * unrelated sections. Deliberately plain: buttons, an underline on the open
 * one, and the caller owns which is open (usually via the URL, so the command
 * palette and links can land on a specific tab).
 */
export function PageTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line px-5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={cx(
            '-mb-px border-b-2 px-3 py-2.5 text-[13px] transition-colors',
            tab.id === active
              ? 'border-accent font-medium text-ink'
              : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
