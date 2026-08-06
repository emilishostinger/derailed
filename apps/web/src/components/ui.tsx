import { AlertCircle, Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
  title,
  body,
  action,
  note,
}: {
  icon: ReactNode;
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
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface text-ink-faint">
          {icon}
        </span>
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
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
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
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
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
