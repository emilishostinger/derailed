import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How wide the service drawer is, remembered between visits.
 *
 * It was a fixed 576px, which is right for a status panel and cramped for the two
 * things people actually sit in it for: reading a deploy log and reading a table of
 * environment variables. Both of those are wide.
 *
 * Dragging rather than a wide/narrow toggle, because there is no single second
 * width that is right: a log wants as much as the screen has, and the topology
 * behind it wants to stay visible while you read.
 */
const KEY = 'derailed.drawer-width';
const DEFAULT = 576;
const MIN = 420;

/** Never so wide that the thing the drawer is about is completely hidden. */
function ceiling(): number {
  if (typeof window === 'undefined') return 1200;
  return Math.max(MIN, Math.min(1400, window.innerWidth - 220));
}

function stored(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value >= MIN ? value : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useDrawerWidth() {
  const [width, setWidth] = useState(() => Math.min(stored(), ceiling()));
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  const apply = useCallback((next: number) => {
    const clamped = Math.round(Math.max(MIN, Math.min(next, ceiling())));
    setWidth(clamped);
    try {
      localStorage.setItem(KEY, String(clamped));
    } catch {
      // Not remembering it only means it opens at the default next time.
    }
  }, []);

  // A window that shrinks below the drawer leaves nothing of the page behind it.
  useEffect(() => {
    const onResize = () => setWidth((current) => Math.min(current, ceiling()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setDragging(true);
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);

      const move = (moved: PointerEvent) => {
        // Coalesced into a frame: the pointer fires far more often than the screen
        // redraws, and resizing a panel this size on every event drops frames.
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => apply(window.innerWidth - moved.clientX));
      };
      const up = () => {
        setDragging(false);
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
    [apply],
  );

  /** Arrow keys, so this is not a mouse-only feature. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 100 : 20;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        apply(width + step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        apply(width - step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        apply(ceiling());
      } else if (event.key === 'End') {
        event.preventDefault();
        apply(DEFAULT);
      }
    },
    [apply, width],
  );

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return {
    width,
    dragging,
    /** Back to the width it has always opened at. */
    reset: () => apply(DEFAULT),
    min: MIN,
    max: ceiling(),
    onPointerDown,
    onKeyDown,
  };
}
