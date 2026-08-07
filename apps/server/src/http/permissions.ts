import type { UserRole } from '@derailed/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth.ts';
import { forbidden } from './errors.ts';

/**
 * Who may do what.
 *
 * Enforced in one place rather than annotated on each route, and the direction of that
 * choice is the whole point. A per-route check is a list of things somebody remembered;
 * the route added next Tuesday is not on it, and nothing fails until it matters. Here,
 * a new route is covered the moment it exists, and the way to widen access is to write
 * it down on purpose.
 *
 * Three roles, because the questions people actually ask are "can they break it?" and
 * "can they see it?":
 *
 * - **Owner** does anything, including changing the server and deciding who else is here.
 * - **Member** runs the apps: deploy, restart, logs, variables, domains, backups. Not
 *   deleting them, and nothing server-shaped.
 * - **Viewer** looks. Perfect for a client, or for showing somebody the problem.
 */

/** Reading is always allowed. Every rule below is about changing something. */
function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

interface Rule {
  /** Matched against the path with `/api` already taken off. */
  path: RegExp;
  /** When absent, the rule covers every method including reads. */
  methods?: string[];
  /** Said to whoever it turned away, in their words rather than ours. */
  why: string;
}

/**
 * The things only an owner may do: change the server, or destroy something.
 *
 * Deliberately about the *machine* rather than the apps on it. A member who cannot
 * deploy is not a member, and a member who can empty the trash or move the whole
 * install to another server is an owner with extra steps.
 */
const OWNER_ONLY: Rule[] = [
  {
    path: /^\/people(\/|$)/,
    why: 'Only an owner can change who has access.',
  },
  {
    path: /^\/tokens(\/|$)/,
    // Including reads. An API token stands in for an owner, so the list of them is
    // the list of keys to the whole machine.
    why: 'Only an owner can manage API tokens, because a token can do anything an owner can.',
  },
  {
    path: /^\/system(\/|$)/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    why: 'Only an owner can change the server itself.',
  },
  {
    path: /^\/updates(\/|$)/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    why: 'Only an owner can update the server.',
  },
  {
    path: /^\/webhooks(\/|$)/,
    // Including reads. The list is where this server talks to on its own, and a
    // signing secret is a shared credential even though the value never comes back.
    why: 'Only an owner can change where this server sends events.',
  },
  {
    path: /^\/trash(\/|$)/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    why: 'Only an owner can empty the trash or put things back.',
  },
  {
    path: /^\/backups\/(offsite|move)(\/|$)/,
    why: 'Only an owner can change where backups go, or move the server.',
  },
  {
    path: /^\/alerts(\/|$)/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    why: 'Only an owner can change where alerts are sent.',
  },
  {
    path: /^\/mail(\/|$)/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    why: 'Only an owner can change how the server sends email.',
  },
  {
    // Both the page itself and which addresses appear on it. Publishing an automatic
    // address discloses the server's IP, so it is the same decision as publishing the
    // page at all.
    path: /^\/uptime\/(status-page|[^/]+\/status-page)$/,
    methods: ['PUT'],
    why: 'Only an owner can publish a status page, because it is visible to anyone.',
  },
  {
    path: /^\/(projects|services)\/[^/]+$/,
    methods: ['DELETE'],
    why: 'Only an owner can delete an app or a project.',
  },
];

export interface Decision {
  ok: boolean;
  why?: string;
}

/**
 * The one function that decides.
 *
 * Exported so the tests can ask it directly, and so the dashboard can grey out what it
 * knows will be refused rather than offering a button that returns an error.
 */
export function mayCall(role: UserRole, method: string, path: string): Decision {
  const route = path.replace(/^\/api/, '') || '/';

  if (role === 'owner') return { ok: true };

  // The owner-only list comes first, and applies to everyone who is not an owner.
  //
  // Checking the viewer's "reads are fine" shortcut before this list was a real hole:
  // some of these rules deliberately cover reads too, because the list of accounts and
  // the list of API tokens are themselves worth keeping to owners. A viewer would have
  // sailed straight past them on a GET.
  for (const rule of OWNER_ONLY) {
    if (!rule.path.test(route)) continue;
    if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue;
    return { ok: false, why: rule.why };
  }

  if (role === 'viewer' && !isRead(method)) {
    return {
      ok: false,
      why: 'You can look at everything here, but not change it.',
    };
  }

  return { ok: true };
}

/** Mounted once, after the session check, so everything below it is covered. */
export const enforceRole: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  const decision = mayCall(user.role, c.req.method, new URL(c.req.url).pathname);
  if (!decision.ok) {
    throw forbidden(
      decision.why ?? 'You do not have access to that.',
      'Ask an owner of this server if you need it.',
    );
  }
  await next();
};
