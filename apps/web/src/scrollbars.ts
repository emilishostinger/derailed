/**
 * Scrollbars that show themselves while you are scrolling and fade back out.
 *
 * CSS can do the hover half of this on its own. It cannot do the other half:
 * there is no selector for "this element is moving right now", which is the case
 * that matters on a trackpad, where you scroll without the pointer ever resting on
 * the bar. So the class goes on from here and comes off when the scrolling stops.
 *
 * One capturing listener on the document rather than one per scrollable region:
 * `scroll` does not bubble, but it does capture, and this way nothing has to
 * remember to opt in.
 */
const IDLE_MS = 700;

export function watchScrolling(): void {
  const timers = new WeakMap<Element, number>();

  document.addEventListener(
    'scroll',
    (event) => {
      // Scrolling the page itself reports the document; the class belongs on <html>.
      const target = event.target;
      const element =
        target instanceof Element
          ? target
          : target instanceof Document
            ? target.documentElement
            : null;
      if (!element) return;

      element.classList.add('is-scrolling');
      window.clearTimeout(timers.get(element));
      timers.set(
        element,
        window.setTimeout(() => {
          element.classList.remove('is-scrolling');
          timers.delete(element);
        }, IDLE_MS),
      );
    },
    { capture: true, passive: true },
  );
}
