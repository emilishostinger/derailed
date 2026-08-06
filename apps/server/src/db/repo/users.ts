import type { User } from '@derailed/shared';
import { decrypt, encrypt } from '../../util/crypto.ts';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export function countUsers(): number {
  return db().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()!.n;
}

export function findUserByEmail(email: string): (User & { passwordHash: string }) | null {
  const row = db()
    .query<UserRow, [string]>('SELECT * FROM users WHERE email = ?')
    .get(email.toLowerCase());
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export function findUserById(id: string): User | null {
  const row = db().query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(id);
  return row ? toUser(row) : null;
}

export function createUser(email: string, passwordHash: string): User {
  const user: UserRow = {
    id: newId(),
    email: email.toLowerCase(),
    password_hash: passwordHash,
    created_at: Date.now(),
  };
  db()
    .query('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, user.email, user.password_hash, user.created_at);
  return toUser(user);
}

export function updateEmail(userId: string, email: string): void {
  db().query('UPDATE users SET email = ? WHERE id = ?').run(email.toLowerCase().trim(), userId);
}

export function updatePassword(userId: string, passwordHash: string): void {
  db().query('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

export function firstUser(): User | null {
  const row = db().query<UserRow, []>('SELECT * FROM users ORDER BY created_at LIMIT 1').get();
  return row ? toUser(row) : null;
}

/**
 * The second factor.
 *
 * The secret is encrypted at rest like every other, and `confirmed` matters: a secret
 * exists from the moment somebody presses "set this up", but two-factor is not on
 * until they have proved they can produce a code from it. Without that distinction,
 * scanning a QR code and closing the tab locks you out of your own server.
 */
export function setTotpSecret(userId: string, secret: string | null): void {
  db()
    .query('UPDATE users SET totp_secret_enc = ?, totp_confirmed_at = NULL WHERE id = ?')
    .run(secret ? encrypt(secret) : null, userId);
}

export function confirmTotp(userId: string): void {
  db().query('UPDATE users SET totp_confirmed_at = ? WHERE id = ?').run(Date.now(), userId);
}

export function totpSecret(userId: string): string | null {
  const row = db()
    .query<{ totp_secret_enc: string | null }, [string]>(
      'SELECT totp_secret_enc FROM users WHERE id = ?',
    )
    .get(userId);
  if (!row?.totp_secret_enc) return null;
  try {
    return decrypt(row.totp_secret_enc);
  } catch {
    return null;
  }
}

export function totpEnabled(userId: string): boolean {
  const row = db()
    .query<{ totp_confirmed_at: number | null }, [string]>(
      'SELECT totp_confirmed_at FROM users WHERE id = ?',
    )
    .get(userId);
  return !!row?.totp_confirmed_at;
}

/** Stored hashed, and single-use: a code that has been spent is spent. */
export function storeRecoveryCodes(userId: string, codes: string[]): void {
  db().query('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  for (const code of codes) {
    db()
      .query('INSERT INTO recovery_codes (id, user_id, hash) VALUES (?, ?, ?)')
      .run(newId(), userId, Bun.password.hashSync(code, { algorithm: 'bcrypt', cost: 10 }));
  }
}

export function countRecoveryCodes(userId: string): number {
  return (
    db()
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
      )
      .get(userId)?.n ?? 0
  );
}

/** Spends one, if it matches. Returns whether it did. */
export function useRecoveryCode(userId: string, code: string): boolean {
  const rows = db()
    .query<{ id: string; hash: string }, [string]>(
      'SELECT id, hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
    )
    .all(userId);

  const clean = code.trim().toUpperCase();
  for (const row of rows) {
    if (Bun.password.verifySync(clean, row.hash)) {
      db().query('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
      return true;
    }
  }
  return false;
}
