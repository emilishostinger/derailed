/**
 * A browser-shaped global environment for the component tests.
 *
 * The server suite runs headless and wants no DOM; the web component tests need one.
 * Rather than force a DOM on every test file through the shared preload, each component
 * test imports this first, before it imports React or Testing Library, so `document`
 * and `window` exist by the time those do. happy-dom is used over jsdom because it is
 * markedly faster to register and tear down, which keeps these tests quick.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof document === 'undefined') {
  GlobalRegistrator.register();
}

/**
 * A marker to import so this module is a *used* import, not a bare side-effect one the
 * import organiser would drop or reorder below React. The registration above runs when
 * this module is evaluated, which is during the import phase, before any test body and
 * so before the first render; only React reading `document` at its own import time
 * would care about ordering, and it does not.
 */
export const domReady = true;
