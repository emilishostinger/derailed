import { useCelebration } from '../stores/celebration.ts';
import { playChime } from './Celebrate.tsx';

/**
 * What happens when a deploy finishes.
 *
 * Split into its own file so the projects store can call it without importing a
 * React component, which would drag JSX into a module that has no business with it
 * and make the store impossible to test on its own.
 *
 * Deployments report progress several times, so this is only ever called on the edge
 * into a finished state. Being called twice for the same deployment would be a chime
 * per step, which is the difference between a nice touch and something you turn off.
 */
let lastCelebrated: string | null = null;

export function celebrateDeploy(kind: 'ok' | 'bad', deploymentId?: string): void {
  if (deploymentId && deploymentId === lastCelebrated) return;
  if (deploymentId) lastCelebrated = deploymentId;

  playChime(kind);
  if (kind === 'ok') useCelebration.getState().maybeConfetti();
}
