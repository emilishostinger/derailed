import type { SystemInfo, User } from '@derailed/shared';
import { create } from 'zustand';
import { ApiError, api } from '../api/client.ts';
import { live } from '../api/ws.ts';
import { useToasts } from './toasts.ts';

type Phase = 'loading' | 'setup' | 'anonymous' | 'authenticated';

interface SessionState {
  phase: Phase;
  user: User | null;
  system: SystemInfo | null;
  bootstrap: () => Promise<void>;
  setup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  setSystem: (system: SystemInfo) => void;
  refreshSystem: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  phase: 'loading',
  user: null,
  system: null,

  async bootstrap() {
    try {
      const { user } = await api.me();
      set({ user, phase: 'authenticated' });
      live.connect();
      void get().refreshSystem();
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        set({ phase: 'anonymous' });
        return;
      }
    }
    // Not signed in, is there an account on this server yet?
    const { setupComplete } = await api.authStatus().catch(() => ({ setupComplete: true }));
    set({ phase: setupComplete ? 'anonymous' : 'setup' });
  },

  async setup(email, password) {
    const { user } = await api.setup(email, password);
    set({ user, phase: 'authenticated' });
    live.connect();
    void get().refreshSystem();
  },

  async login(email, password) {
    const { user } = await api.login(email, password);
    set({ user, phase: 'authenticated' });
    live.connect();
    void get().refreshSystem();
  },

  async logout() {
    await api.logout().catch(() => undefined);
    live.disconnect();
    set({ user: null, phase: 'anonymous', system: null });
  },

  setUser(user) {
    set({ user });
  },

  setSystem(system) {
    set({ system });
  },

  async refreshSystem() {
    try {
      const { system } = await api.system();
      set({ system });
    } catch {
      // the socket will bring it back
    }
  },
}));

live.on((event) => {
  if (event.type === 'system') useSession.getState().setSystem(event.system);

  /**
   * Things the server wants said out loud.
   *
   * The server has published these since the beginning and nothing on this side ever
   * listened, so a certificate that failed to renew, or a domain that finally started
   * working, went nowhere. Setting up a domain in particular means going away to
   * somebody else's website and coming back not knowing whether it took; that is the
   * moment worth interrupting for.
   */
  if (event.type === 'notice') {
    useToasts.getState().push({
      message: event.message,
      // Three tones exist here, and 'warn' is not one of them: a warning that
      // cannot be acted on reads the same as an error to whoever is looking.
      tone: event.level === 'error' ? 'danger' : 'info',
    });
  }
});
