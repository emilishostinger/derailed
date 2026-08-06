import { create } from 'zustand';
import { hasCelebratedFirstDeploy } from '../components/Celebrate.tsx';

/**
 * Whether confetti is falling right now.
 *
 * A store rather than state in the layout, because the thing that triggers it is a
 * websocket event handled in another store entirely, and threading a callback from
 * there to the top of the tree would be a lot of plumbing for some paper.
 */
interface CelebrationState {
  confetti: boolean;
  /** Starts it, but only for the first deploy that has ever worked here. */
  maybeConfetti: () => void;
  stop: () => void;
}

export const useCelebration = create<CelebrationState>((set) => ({
  confetti: false,
  maybeConfetti: () => {
    if (hasCelebratedFirstDeploy()) return;
    set({ confetti: true });
  },
  stop: () => set({ confetti: false }),
}));
