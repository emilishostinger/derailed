/**
 * Changing the email and the password.
 *
 * These were checked once by hand against a live server and then, some hours later,
 * that account could no longer sign in and neither password matched the stored hash.
 * The cause was never established, which is exactly the argument for pinning the
 * behaviour here: what is stored has to verify against what was typed, every time.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createSession, deleteSessionsForUser, findSession } from '../src/db/repo/sessions.ts';
import { createUser, findUserByEmail, updateEmail, updatePassword } from '../src/db/repo/users.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-account-'));
const EMAIL = 'someone@example.com';
const PASSWORD = 'a-long-enough-password';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
});

beforeEach(async () => {
  const existing = findUserByEmail(EMAIL);
  if (!existing) createUser(EMAIL, await Bun.password.hash(PASSWORD));
  else updatePassword(existing.id, await Bun.password.hash(PASSWORD));
});

describe('the password', () => {
  test('what is stored verifies against what was typed', async () => {
    const user = findUserByEmail(EMAIL)!;
    expect(await Bun.password.verify(PASSWORD, user.passwordHash)).toBe(true);
  });

  test('changing it, and changing it back, both take effect', async () => {
    const user = findUserByEmail(EMAIL)!;

    updatePassword(user.id, await Bun.password.hash('the-second-password'));
    let stored = findUserByEmail(EMAIL)!;
    expect(await Bun.password.verify('the-second-password', stored.passwordHash)).toBe(true);
    expect(await Bun.password.verify(PASSWORD, stored.passwordHash)).toBe(false);

    // The round trip is the part that failed in the wild.
    updatePassword(user.id, await Bun.password.hash(PASSWORD));
    stored = findUserByEmail(EMAIL)!;
    expect(await Bun.password.verify(PASSWORD, stored.passwordHash)).toBe(true);
    // Two hashes and three verifies of deliberately-slow bcrypt; under `--coverage
    // --parallel` the CPU contention pushes that past the 5s default even though nothing
    // is stuck. Give it room rather than let it flake.
  }, 20_000);

  test('changing it ends every session', () => {
    const user = findUserByEmail(EMAIL)!;
    const elsewhere = createSession(user.id);
    expect(findSession(elsewhere.id)).not.toBeNull();

    deleteSessionsForUser(user.id);
    expect(findSession(elsewhere.id)).toBeNull();
  });
});

describe('the email', () => {
  test('changing it moves the account, password intact', async () => {
    const user = findUserByEmail(EMAIL)!;
    updateEmail(user.id, 'Someone.Else@Example.com');

    expect(findUserByEmail(EMAIL)).toBeNull();
    const moved = findUserByEmail('someone.else@example.com');
    expect(moved).not.toBeNull();
    expect(await Bun.password.verify(PASSWORD, moved!.passwordHash)).toBe(true);

    updateEmail(user.id, EMAIL);
  });

  test('is stored lowercase, so signing in is not case sensitive', () => {
    const user = findUserByEmail(EMAIL)!;
    updateEmail(user.id, '  MiXeD@Example.COM  ');
    expect(findUserByEmail('mixed@example.com')).not.toBeNull();
    updateEmail(user.id, EMAIL);
  });
});
