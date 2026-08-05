import { FriendlyError } from '../build/git.ts';
import { deleteEnv, listEnv, setEnv } from '../db/repo/env.ts';
import {
  findLink,
  createLink as insertLink,
  linksFrom,
  linksTo,
  deleteLink as removeLink,
} from '../db/repo/links.ts';
import { findService } from '../db/repo/services.ts';
import { emitProject, emitService } from '../runtime/present.ts';
import { connectionUrl, credentialsFor } from './create.ts';
import { findEngine } from './databases.ts';

/**
 * Connecting an app to a database materialises one environment variable on the app.
 * It is marked `source=link`, so the variables editor shows it read-only and the app
 * owner can't accidentally clobber it. And it disappears cleanly when unlinked.
 */
export function connectServices(
  fromServiceId: string,
  toServiceId: string,
  injectAs?: string,
  /**
   * Also set HOST/PORT/NAME/USER/PASSWORD variables. Plenty of real apps -
   * WordPress among them, never read a connection URL, so a link that only sets
   * one silently does nothing useful.
   */
  discrete?: boolean,
): { key: string } {
  const from = findService(fromServiceId);
  const to = findService(toServiceId);
  if (!from || !to) throw new FriendlyError("One of those services doesn't exist.");
  if (from.projectId !== to.projectId) {
    throw new FriendlyError('Services can only be connected inside the same project.');
  }
  if (from.id === to.id) throw new FriendlyError("A service can't be connected to itself.");
  if (to.kind !== 'database') {
    throw new FriendlyError(
      `${to.name} isn't a database.`,
      'Apps talk to each other by name on the project network. No connection needed.',
    );
  }

  const engine = findEngine(to.dbEngine ?? '');
  const key = injectAs ?? engine?.defaultInjectKey ?? 'DATABASE_URL';

  const clash = listEnv(from.id).find((entry) => entry.key === key && entry.source === 'user');
  if (clash) {
    throw new FriendlyError(
      `${from.name} already has a variable called ${key}.`,
      'Remove it first, or choose a different name for this connection.',
    );
  }

  const existing = linksFrom(from.id).find((link) => link.toServiceId === to.id);
  if (existing) {
    throw new FriendlyError(`${from.name} is already connected to ${to.name}.`);
  }

  const url = connectionUrl(to);
  if (!url) throw new FriendlyError(`${to.name} isn't ready yet. Try again in a moment.`);

  insertLink(from.projectId, from.id, to.id, injectAs ?? null);
  setEnv(from.id, key, url, 'link');

  if (discrete) {
    const credentials = credentialsFor(to);
    if (credentials && engine) {
      const prefix = key.replace(/_?URL$/i, '') || 'DATABASE';
      setEnv(from.id, `${prefix}_HOST`, credentials.host, 'link');
      setEnv(from.id, `${prefix}_PORT`, String(engine.port), 'link');
      setEnv(from.id, `${prefix}_NAME`, credentials.dbName, 'link');
      setEnv(from.id, `${prefix}_USER`, credentials.user, 'link');
      setEnv(from.id, `${prefix}_PASSWORD`, credentials.password, 'link');
    }
  }
  emitService(from.id);
  emitService(to.id);
  // Edges live on the project, so the topology view needs the project too.
  emitProject(from.projectId);
  return { key };
}

export function disconnectServices(linkId: string): void {
  const link = findLink(linkId);
  if (!link) throw new FriendlyError("That connection doesn't exist.");

  const to = findService(link.toServiceId);
  const engine = to ? findEngine(to.dbEngine ?? '') : null;
  const key = link.injectAs ?? engine?.defaultInjectKey ?? 'DATABASE_URL';

  deleteEnv(link.fromServiceId, key);
  const prefix = key.replace(/_?URL$/i, '') || 'DATABASE';
  for (const suffix of ['HOST', 'PORT', 'NAME', 'USER', 'PASSWORD']) {
    deleteEnv(link.fromServiceId, `${prefix}_${suffix}`);
  }
  removeLink(link.id);
  emitService(link.fromServiceId);
  if (to) emitService(to.id);
  emitProject(link.projectId);
}

/** Refreshes link-sourced variables, used when a database's credentials change. */
export function refreshLinksTo(serviceId: string): void {
  const to = findService(serviceId);
  if (!to) return;
  const url = connectionUrl(to);
  if (!url) return;
  const engine = findEngine(to.dbEngine ?? '');

  for (const link of linksTo(serviceId)) {
    const key = link.injectAs ?? engine?.defaultInjectKey ?? 'DATABASE_URL';
    setEnv(link.fromServiceId, key, url, 'link');
    emitService(link.fromServiceId);
  }
}
