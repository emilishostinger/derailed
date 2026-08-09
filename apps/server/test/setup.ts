/**
 * Test preload (see bunfig.toml): every test run gets its own throwaway data dir,
 * set before src/config.ts is imported anywhere.
 */
import { beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hand the rate limiters back full before every test, across every file.
 *
 * The sign-in and sign-up limiters are process-wide singletons keyed by the caller's
 * IP, and in tests every request comes from the same 'local' peer, so their budgets
 * are one shared bucket for the whole run. Spread over a hundred-odd files that each
 * sign in or set up, that bucket fills; on a fast run, where the whole suite finishes
 * inside the limiters' one-minute window, it fills for good, and every later setup or
 * login fails with a 429 that has nothing to do with what the test was checking. A few
 * files reset these in their own hooks; doing it here, once, means none has to remember
 * and a new file cannot reintroduce the flake. Imported lazily so this preload does not
 * drag the whole app graph in before `src/config.ts` has its data dir.
 */
beforeEach(async () => {
  try {
    const { loginLimiter, peerLimiter, setupLimiter } = await import('../src/http/routes/auth.ts');
    loginLimiter.resetAll();
    peerLimiter.resetAll();
    setupLimiter.resetAll();
  } catch {
    // A test file that never pulls auth into the process has no limiters to reset.
  }
});

process.env.DERAILED_DATA ??= mkdtempSync(join(tmpdir(), 'derailed-test-'));
process.env.DERAILED_DEV = '1';

// The Nixpacks binary is 20 MB and lives under the data dir, so a fresh temp dir per
// run means downloading it again every time, and the test that uses it timing out on
// any connection that is not fast. Cached once per machine instead.
const nixpacksCache = join(tmpdir(), 'derailed-nixpacks-cache');
mkdirSync(nixpacksCache, { recursive: true });
process.env.DERAILED_BIN ??= nixpacksCache;

// Integration tests drive a real Caddy container. Give it its own name, network and
// ports so a test run never touches a Derailed install on the same machine.
process.env.DERAILED_CADDY_NAME ??= 'derailed-test-caddy';
process.env.DERAILED_CADDY_NETWORK ??= 'derailed-test-proxy';
process.env.DERAILED_CADDY_HTTP ??= '18080';
process.env.DERAILED_CADDY_HTTPS ??= '18443';
process.env.DERAILED_CADDY_ADMIN ??= '12019';
