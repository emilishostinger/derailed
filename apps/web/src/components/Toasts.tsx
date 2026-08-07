import { Check, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Toast, useToasts } from '../stores/toasts.ts';
import { cx, Spinner } from './ui.tsx';

/**
 * Short-lived messages, and the offer to undo what caused them.
 *
 * Pinned to the bottom right of the window.
 *
 * Centred looked right in the abstract and wrong in place. The sidebar takes the left
 * of the screen, so the canvas people are actually reading sits right of centre, and a
 * toast centred on the *window* lands off to the left of everything it is talking
 * about. The bottom right is the corner nearest the work.
 */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none fixed right-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

const TONES = {
  info: { icon: Info, className: 'text-ink-muted' },
  ok: { icon: Check, className: 'text-ok' },
  danger: { icon: TriangleAlert, className: 'text-danger' },
} as const;

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [busy, setBusy] = useState(false);
  const { icon: Icon, className } = TONES[toast.tone];

  useEffect(() => {
    // Held open while the action is running, or a slow undo would dismiss itself
    // half way through and leave nothing saying whether it worked.
    if (busy) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.ms);
    return () => clearTimeout(timer);
  }, [busy, dismiss, toast.id, toast.ms]);

  return (
    <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-3.5 py-2.5 shadow-[var(--d-shadow-card)]">
      <Icon className={cx('h-4 w-4 shrink-0', className)} />
      <p className="min-w-0 flex-1 text-[13px] text-ink">{toast.message}</p>

      {toast.action && (
        <button
          type="button"
          className="btn-secondary shrink-0 !py-1 !text-[12px]"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await toast.action?.run();
              dismiss(toast.id);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />}
          {toast.action.label}
        </button>
      )}

      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-ink-faint hover:text-ink"
        onClick={() => dismiss(toast.id)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
