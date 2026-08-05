import type { SystemInfo, User } from '@derailed/shared';
import { create } from 'zustand';
import { ApiError, api } from '../api/client.ts';
import { live } from '../api/ws.ts';

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
});
