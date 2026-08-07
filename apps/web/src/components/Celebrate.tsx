import { useEffect, useRef } from 'react';

/**
 * Noticing when something goes right.
 *
 * Deploying is the moment this whole product exists for, and until now it ended with
 * a status dot quietly turning green. A sound and, the first time, some confetti, is
 * not a feature so much as an acknowledgement that the person did a thing.
 *
 * Off by default and remembered in the browser rather than on the server: whether you
 * want your laptop to make a noise is a fact about the room you are sitting in, not
 * about the server, and somebody else signing in from an office should not inherit it.
 */
const SOUND_KEY = 'derailed.sounds';

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSoundsEnabled(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    // Private browsing, or storage full. Nothing here is worth an error.
  }
}

/**
 * Two short tones, synthesised rather than shipped.
 *
 * An audio file would be a few kilobytes in the binary and a decision about which
 * format to bundle; the Web Audio API makes both notes in a dozen lines and nothing
 * to download. Rising for success, falling for failure, because that mapping is
 * older than software.
 */
export function playChime(kind: 'ok' | 'bad'): void {
  if (!soundsEnabled()) return;

  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const context = new Ctor();
    const notes = kind === 'ok' ? [523.25, 659.25, 783.99] : [392, 329.63];

    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      // A sine wave rather than anything with harmonics: this has to be pleasant on
      // the fiftieth deploy, not just the first.
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      const start = context.currentTime + index * 0.09;
      // Ramped rather than switched, because an instant start and stop is a click.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    });

    setTimeout(() => void context.close().catch(() => undefined), 1200);
  } catch {
    // No audio on this machine, or the browser refused without a user gesture.
  }
}

const CONFETTI_KEY = 'derailed.confetti';

/**
 * On unless somebody turned it off.
 *
 * It used to fire once, on the first deploy that ever worked on a server, which meant
 * almost nobody ever saw it: the first deploy is usually the one you are still working
 * out, and by the time things are going well the moment has been spent. A deploy
 * working is the good part of this product, and three seconds of paper is a cheap way
 * to say so.
 */
export function confettiEnabled(): boolean {
  try {
    return localStorage.getItem(CONFETTI_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setConfettiEnabled(on: boolean): void {
  try {
    localStorage.setItem(CONFETTI_KEY, on ? '1' : '0');
  } catch {
    // Private browsing. It stays on, which is the friendlier way to fail.
  }
}

/**
 * Confetti, on a deploy that worked.
 *
 * Canvas rather than a few hundred DOM nodes, and it removes itself. Respects
 * `prefers-reduced-motion`, since "delightful" and "makes some people feel ill" are
 * not a trade worth making for three seconds of paper.
 */
export function Confetti({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      onDone();
      return;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colours = ['#7236e3', '#5f27c9', '#22c55e', '#eab308', '#ec4899'];
    const pieces = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.4,
      size: 5 + Math.random() * 6,
      speed: 2 + Math.random() * 3,
      drift: -1 + Math.random() * 2,
      spin: -0.2 + Math.random() * 0.4,
      angle: Math.random() * Math.PI * 2,
      colour: colours[Math.floor(Math.random() * colours.length)] ?? colours[0]!,
    }));

    let frame = 0;
    let raf = 0;

    const tick = () => {
      frame++;
      context.clearRect(0, 0, canvas.width, canvas.height);

      for (const piece of pieces) {
        piece.y += piece.speed;
        piece.x += piece.drift;
        piece.angle += piece.spin;

        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.angle);
        context.fillStyle = piece.colour;
        context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.6);
        context.restore();
      }

      // About four seconds, or once everything has fallen off the bottom.
      if (frame < 240 && pieces.some((piece) => piece.y < canvas.height + 40)) {
        raf = requestAnimationFrame(tick);
      } else {
        onDone();
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);

  return (
    <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-[60]" />
  );
}
