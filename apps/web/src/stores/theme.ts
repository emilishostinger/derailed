import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const KEY = 'derailed.theme';

/**
 * Dark is the default. The class is applied to <html> by an inline script in
 * index.html before first paint, so this store starts from whatever that decided
 * rather than guessing again and causing a flash.
 */
function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: currentTheme(),

  setTheme(theme) {
    // Every surface animates its colours, so without this the theme arrives in a
    // ripple: borders first, then text, then backgrounds. Killing transitions for a
    // single frame makes the whole page change at once.
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.classList.toggle('light', theme === 'light');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('theme-switching'));
    });
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#edeff4' : '#0b0c11');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Private browsing: the theme just won't persist, which is survivable.
    }
    set({ theme });
  },

  toggle() {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },
}));
