import { Hono } from 'hono';
import { createToken, deleteToken, listTokens } from '../../db/repo/tokens.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, notFound } from '../errors.ts';

export const tokenRoutes = new Hono<AppEnv>();

tokenRoutes.get('/', (c) => c.json({ tokens: listTokens() }));

/**
 * The secret is returned exactly once, here. It is stored only as a hash, so there is
 * no endpoint that can ever show it again.
 */
tokenRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (!name) throw badRequest('Give this token a name so you can recognise it later.');

  const { token, secret } = createToken(name);
  return c.json({ token, secret }, 201);
});

tokenRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!listTokens().some((token) => token.id === id)) throw notFound('That token');
  deleteToken(id);
  return c.json({ ok: true });
});
