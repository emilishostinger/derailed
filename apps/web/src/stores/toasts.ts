import { create } from 'zustand';

/**
 * The strip of short-lived messages at the bottom of the screen.
 *
 * It exists for one reason: a destructive action needs somewhere to offer to take
 * itself back. A dialog cannot do that, because by the time you regret pressing the
 * button the dialog has gone. Everything else it shows is a bonus.
 */
export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'ok' | 'danger';
  /** An offer to reverse what just happened, shown as a button on the toast. */
  action?: { label: string; run: () => void | Promise<void> };
  /** How long it stays. Anything with an action gets longer, since it must be read. */
  ms: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'ms'> & { ms?: number }) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

/** Long enough to notice and reach, short enough not to sit there. */
const DEFAULT_MS = 5000;
const WITH_ACTION_MS = 10_000;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    const ms = toast.ms ?? (toast.action ? WITH_ACTION_MS : DEFAULT_MS);
    set((state) => ({ toasts: [...state.toasts, { ...toast, id, ms }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** The common case, so callers do not each invent their own wording for "Undo". */
export function toastUndo(message: string, undo: () => void | Promise<void>): void {
  useToasts.getState().push({ message, tone: 'info', action: { label: 'Undo', run: undo } });
}
