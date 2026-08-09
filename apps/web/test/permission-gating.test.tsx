// The DOM has to exist before React or Testing Library are imported, so this comes
// first, on its own line, and nothing is allowed to sort above it.
import './dom-setup.ts';

/**
 * The UI hides what the server would refuse.
 *
 * The permission matrix proves the *server* says no to the wrong role. This proves the
 * dashboard does not dangle a control the server would then reject: a button that
 * returns a 403 is a worse experience than no button, and, more importantly, a viewer
 * being shown owner-only machinery is the client-side half of the same boundary the
 * whole project is careful about.
 *
 * CloudflareDns is a clean example: `PUT /system/dns` is owner-only (the /system rule),
 * and the panel returns null for anyone who is not an owner. So a viewer and a member
 * see nothing; an owner sees the panel. Driven as a real render, with the role coming
 * from the same session store the app uses.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { User, UserRole } from '@derailed/shared';
import { cleanup, render, waitFor } from '@testing-library/react';
import { endpoints } from '../src/api/endpoints.ts';
import { CloudflareDns } from '../src/components/CloudflareDns.tsx';
import { useSession } from '../src/stores/session.ts';
// Registers the happy-dom globals; the side effect runs on import, before any render.
import { domReady } from './dom-setup.ts';

// Referenced so the import is never dropped as unused; the value itself is incidental.
void domReady;

// The panel fetches its state on mount; give it a configured one so the owner path has
// something to draw and no real network is touched.
spyOn(endpoints, 'dnsState').mockResolvedValue({
  configured: true,
  zones: [{ id: 'z1', name: 'example.com' }],
});

function signInAs(role: UserRole) {
  useSession.setState({
    phase: 'authenticated',
    user: { id: 'u1', email: `${role}@test`, role } as User,
  });
}

afterEach(() => {
  cleanup();
});

describe('the Cloudflare DNS panel is shown to an owner and hidden from everyone else', () => {
  test('an owner sees the panel', async () => {
    signInAs('owner');
    const { container } = render(<CloudflareDns />);
    // Its content appears once the state has loaded.
    await waitFor(() => {
      expect(container.textContent).toContain('Cloudflare');
    });
  });

  test('a member sees nothing (the panel renders empty)', async () => {
    signInAs('member');
    const { container } = render(<CloudflareDns />);
    // The effect still runs, but the role gate returns null regardless, so the panel
    // never appears. Give the mounted effect a tick to resolve, then confirm nothing
    // was drawn.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  test('a viewer sees nothing either', async () => {
    signInAs('viewer');
    const { container } = render(<CloudflareDns />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});
