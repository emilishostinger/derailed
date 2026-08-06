import { schemas } from '@derailed/shared';
import { Hono } from 'hono';
import { deleteSessionsForUser } from '../../db/repo/sessions.ts';
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  listUsers,
  setRole,
} from '../../db/repo/users.ts';
import type { AppEnv } from '../auth.ts';
import { badRequest, conflict, forbidden, notFound, parseBody } from '../errors.ts';

/**
 * The people who can get in.
 *
 * Owner-only in its entirety, enforced centrally in `permissions.ts` rather than here,
 * so that a route added to this file later is covered before it is written.
 *
 * There is no invitation email, and that is deliberate rather than unfinished. Derailed
 * has no outbound mail of its own to rely on, and a feature that silently does nothing
 * on a server with no relay configured is worse than one that never claimed to. An
 * owner sets the first password and passes it on however they already talk to that
 * person, and the account is told to change it.
 */
export const peopleRoutes = new Hono<AppEnv>();

peopleRoutes.get('/', (c) => {
  const me = c.get('user');
  return c.json({ people: listUsers(), you: me.id });
});

peopleRoutes.post('/', async (c) => {
  const body = await parseBody(c, schemas.addPersonRequest);

  if (findUserByEmail(body.email)) {
    throw conflict(
      'Somebody with that email address is already here.',
      'Change what they can do from the list instead.',
    );
  }

  const me = c.get('user');
  const person = createUser(body.email, await Bun.password.hash(body.password), body.role, me.id);
  return c.json({ person }, 201);
});

peopleRoutes.put('/:id/role', async (c) => {
  const id = c.req.param('id');
  const person = findUserById(id);
  if (!person) throw notFound('That person');

  const { role } = await parseBody(c, schemas.setRoleRequest);
  const me = c.get('user');

  // Stepping down from your own last owner account leaves a server nobody can
  // administer, which is not a thing to discover after pressing a dropdown.
  if (person.id === me.id && role !== 'owner') {
    throw badRequest(
      'You cannot reduce your own access.',
      'Make somebody else an owner first, and let them do it.',
    );
  }

  if (!setRole(id, role)) {
    throw forbidden(
      'This is the only owner, so their access cannot be reduced.',
      'Make somebody else an owner first.',
    );
  }

  // Not signed out: a viewer who was a member keeps their session and simply finds
  // the buttons refused, which is the same check every request already goes through.
  return c.json({ person: findUserById(id) });
});

peopleRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  const person = findUserById(id);
  if (!person) throw notFound('That person');

  const me = c.get('user');
  if (person.id === me.id) {
    throw badRequest(
      'You cannot remove your own account.',
      'Ask another owner to do it, if that is what you want.',
    );
  }

  if (!deleteUser(id)) {
    throw forbidden(
      'This is the only owner, so they cannot be removed.',
      'Make somebody else an owner first.',
    );
  }

  // Belt and braces: `deleteUser` clears their sessions, and so does this. An account
  // that is gone but whose cookie still opens the door is not gone.
  deleteSessionsForUser(id);
  return c.json({ ok: true });
});
