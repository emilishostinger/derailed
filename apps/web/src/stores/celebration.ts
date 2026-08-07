import { create } from 'zustand';
import { confettiEnabled } from '../components/Celebrate.tsx';

/**
 * Whether confetti is falling right now.
 *
 * A store rather than state in the layout, because the thing that triggers it is a
 * websocket event handled in another store entirely, and threading a callback from
 * there to the top of the tree would be a lot of plumbing for some paper.
 */
interface CelebrationState {
  confetti: boolean;
  /** Starts it, unless somebody has turned it off. */
  maybeConfetti: () => void;
  stop: () => void;
}

export const useCelebration = create<CelebrationState>((set) => ({
  confetti: false,
  maybeConfetti: () => {
    if (!confettiEnabled()) return;
    set({ confetti: true });
  },
  stop: () => set({ confetti: false }),
}));
