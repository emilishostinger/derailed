import type { User } from '@derailed/shared';
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
