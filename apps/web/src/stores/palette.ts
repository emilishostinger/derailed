import { create } from 'zustand';

/**
 * Whether the command palette is open.
 *
 * A single boolean does not obviously need a store, and it lived in the layout as
 * ordinary state until the way in moved to the page header. The header is rendered
 * by each page, so opening it from there meant threading a callback through ten
 * pages that have no other interest in it. This is the smaller thing.
 */
interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
