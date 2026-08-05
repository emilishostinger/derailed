import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

export interface ApiToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
}

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/**
 * Tokens are stored as a SHA-256 hash, never in the clear. There is deliberately no
 * way to read one back: if it is lost, make another and revoke the old one.
 *
 * Plain SHA-256 rather than a slow hash because these are 32 bytes of real randomness,
 * not a human-chosen password, so there is nothing to brute force.
 */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export const TOKEN_PREFIX = 'drl_';

export function listTokens(): ApiToken[] {
  return db()
    .query<TokenRow, []>('SELECT * FROM api_tokens ORDER BY created_at DESC')
    .all()
    .map(toToken);
}

/** Returns the token itself exactly once. */
export function createToken(name: string): { token: ApiToken; secret: string } {
  const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const id = newId();
  db()
    .query('INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, hash(secret), Date.now());
  const row = db().query<TokenRow, [string]>('SELECT * FROM api_tokens WHERE id = ?').get(id)!;
  return { token: toToken(row), secret };
}

export function deleteToken(id: string): void {
  db().query('DELETE FROM api_tokens WHERE id = ?').run(id);
}

/** Looks a token up by its value. Also records that it was used. */
export function verifyToken(secret: string): ApiToken | null {
  const row = db()
    .query<TokenRow, [string]>('SELECT * FROM api_tokens WHERE token_hash = ?')
    .get(hash(secret));
  if (!row) return null;
  db().query('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return toToken(row);
}
