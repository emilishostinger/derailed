import type { Service } from '@derailed/shared';
import { listEnv } from '../db/repo/env.ts';
import { linksFrom } from '../db/repo/links.ts';
import { findService, listServices } from '../db/repo/services.ts';
import { listVolumesFor } from '../db/repo/volumes.ts';
import { connectionUrl, credentialsFor } from './create.ts';
import { findEngine } from './databases.ts';
import type { TemplateConnection } from './templates.ts';

/**
 * Turning an app you have set up into a template somebody else can run.
 *
 * You could already paste a template link and get an app; there was no way to produce
 * one. That is the wrong half of the feature to have: the twenty in the catalogue are
 * a feature, and the two hundred other people write are the point, and nobody writes
 * a template file by hand from a documentation page.
 *
 * The whole difficulty is that an app's variables are where its secrets live. A
 * template carrying somebody's live database password, session key or API token is
 * not a mistake you get to make twice, and the person exporting it is by definition
 * about to publish the file. So nothing is included unless it is understood: values
 * that came from a database become `{placeholder}`s, values that look like secrets
 * become names to generate fresh, and everything else is copied as it stands.
 */

/** The shape written to the file. Deliberately the same one `parseTemplate` reads. */
export interface SharedTemplate {
  name: string;
  slug: string;
  blurb: string;
  image: string;
  port: number;
  volumes: string[];
  env?: Record<string, string>;
  generatedEnv?: string[];
  database?: { engine: string; version: string; env: Record<string, string> };
  afterDeploy: string;
}

/**
 * Names that hold a secret often enough to be worth assuming they do.
 *
 * Wrong in the safe direction on purpose. Treating a harmless variable as a secret
 * costs whoever installs the template a value they have to set; treating a secret as
 * harmless publishes it. The first is an inconvenience and the second is an incident.
 */
const SECRET_NAME =
  /(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|credential|salt|cipher|signing|auth[_-]?key|access[_-]?key|session[_-]?key|encryption)/i;

/** A value long and random-looking enough that publishing it would be a mistake. */
function looksGenerated(value: string): boolean {
  if (value.length < 20) return false;
  // No spaces, mixed classes, and long. That is a key, not a setting.
  return /^[A-Za-z0-9+/=_\-.]{20,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

export class ShareError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ShareError';
    this.hint = hint;
  }
}

/**
 * Every database whose credentials could be sitting in this app's variables.
 *
 * Deliberately not just the linked one. The link is bookkeeping for the topology
 * view, and it is written on a best-effort basis: installing a template creates the
 * app, sets its variables from the database, and then tries to record a link inside a
 * `try` that swallows failures. So an app can hold a live password with no link to
 * explain where it came from, and asking only the link is how that password gets
 * published. Found by looking, not by asking.
 *
 * Ordered so the linked one wins, since that is the one the template should describe.
 */
function candidateDatabases(service: Service): Service[] {
  const linked = linksFrom(service.id)
    .map((link) => findService(link.toServiceId))
    .filter((entry): entry is Service => entry?.kind === 'database');

  const rest = listServices().filter(
    (entry) => entry.kind === 'database' && !linked.some((one) => one.id === entry.id),
  );
  return [...linked, ...rest];
}

/** A database's connection details, or null when they cannot be read. */
function connectionFor(database: Service): TemplateConnection | null {
  const credentials = credentialsFor(database);
  const engine = findEngine(database.dbEngine ?? '');
  const url = connectionUrl(database);
  if (!credentials || !engine || !url) return null;
  return {
    host: credentials.host,
    port: engine.port,
    dbName: credentials.dbName,
    user: credentials.user,
    password: credentials.password,
    url,
  };
}

/**
 * The two fields that must never appear anywhere, in any form.
 *
 * Replaced wherever they occur, including inside a longer string, because a
 * connection URL is a longer string with a password in the middle of it.
 */
const SECRET_FIELDS = ['url', 'password'] as const;

/**
 * The rest: a host, a port, a database name, a user.
 *
 * Replaced only when they are the whole value, never as a substring. These are short,
 * ordinary words and they are the same across every database on the server, so
 * substring matching turns them into a hazard rather than a convenience: with a user
 * called `derailed` and a database called `postgres`, `DATABASE_TYPE=postgresql`
 * became `{dbName}ql` and an unrelated salt that happened to read `derailed` became
 * `{user}`. Both of those were real, in the first template exported from a real
 * server.
 */
const PLAIN_FIELDS = ['host', 'port', 'dbName', 'user'] as const;

/**
 * Replaces anything that came from this database with the placeholder for it.
 *
 * Done by value rather than by variable name, because no two apps agree on names and
 * the value is the thing that must not escape.
 */
function withPlaceholders(value: string, connection: TemplateConnection): string {
  let out = value;

  // Longest first, so the URL is matched before the password inside it.
  const secrets = [...SECRET_FIELDS].sort(
    (a, b) => String(connection[b]).length - String(connection[a]).length,
  );
  for (const field of secrets) {
    const actual = String(connection[field]);
    if (actual.length < 8) continue;
    out = out.split(actual).join(`{${field}}`);
  }

  for (const field of PLAIN_FIELDS) {
    const actual = String(connection[field]);
    if (!actual) continue;
    if (out === actual) return `{${field}}`;
    // `host:port` is how half the world writes a database address, and it is the one
    // compound worth knowing about.
    if (out === `${actual}:${connection.port}` && field === 'host') {
      return `{${field}}:{port}`;
    }
  }
  return out;
}

/**
 * Whether this value belongs to this database rather than merely resembling it.
 *
 * Decided on the secret fields alone. Every database on a server shares a user name
 * and often a port, so a value matching one of those says nothing about which
 * database it came from, and picking the wrong one means substituting the wrong
 * password: the value looks handled and the real password is still in it. That
 * happened, and only the final sweep caught it.
 */
function belongsTo(value: string, connection: TemplateConnection): boolean {
  return SECRET_FIELDS.some((field) => {
    const actual = String(connection[field]);
    return actual.length >= 8 && value.includes(actual);
  });
}

export function shareTemplate(serviceId: string): SharedTemplate {
  const service = findService(serviceId);
  if (!service) throw new ShareError('That app no longer exists.');
  if (service.kind !== 'app') throw new ShareError('Only apps can be shared as a template.');
  if (!service.image) {
    throw new ShareError(
      `${service.name} is built from source, so there is no image to share.`,
      'A template names an image anybody can pull. Apps built from a repository are shared by sharing the repository.',
    );
  }
  if (!service.port) {
    throw new ShareError(
      `Derailed does not know which port ${service.name} listens on.`,
      'Set it on the app settings first, or nobody installing this will get a working site.',
    );
  }

  const candidates = candidateDatabases(service)
    .map((database) => ({ database, connection: connectionFor(database) }))
    .filter(
      (entry): entry is { database: Service; connection: TemplateConnection } =>
        entry.connection !== null,
    );

  const env: Record<string, string> = {};
  const databaseEnv: Record<string, string> = {};
  const generatedEnv: string[] = [];
  /** Which database this template ends up describing, decided by what was found. */
  let describing: { database: Service; connection: TemplateConnection } | null = null;

  for (const entry of listEnv(service.id)) {
    // Variables Derailed itself injects are recreated by whoever installs this, from
    // their own server. Carrying ours over would point their app at our machine.
    if (entry.source !== 'user') continue;

    // Order matters here, and each step is a case that got the previous order wrong.
    //
    // First: does this value actually contain a database secret. If it does, it is a
    // database variable whatever it is called, and the placeholder is the right answer
    // even for a key named `..._password`, because the installing server supplies one.
    const owner = candidates.find(({ connection }) => belongsTo(entry.value, connection));
    if (owner) {
      describing ??= owner;
      databaseEnv[entry.key] = withPlaceholders(entry.value, owner.connection);
      continue;
    }

    // Second: does it look like a secret in its own right. Before the plain-field
    // match below, because those fields are short ordinary words and a value can
    // equal one by coincidence: a salt that happens to read `derailed`, on a server
    // whose database user is also `derailed`, is a salt and not a user name.
    if (SECRET_NAME.test(entry.key) || looksGenerated(entry.value)) {
      generatedEnv.push(entry.key);
      continue;
    }

    // Last: is it exactly a host, port, database name or user. Whole values only.
    const named = candidates[0];
    const substituted = named ? withPlaceholders(entry.value, named.connection) : entry.value;
    if (named && substituted !== entry.value) {
      describing ??= named;
      databaseEnv[entry.key] = substituted;
      continue;
    }

    env[entry.key] = entry.value;
  }

  // A guard on the rules above rather than a rule of its own.
  //
  // As written it cannot fire: the substitution loop already replaces every one of
  // these passwords wherever it finds it, so nothing carrying one survives to here.
  // It is kept because that is a property of the loop above and not of this function,
  // and the loop is the sort of thing somebody adds an early `continue` to. If this
  // ever does drop something, the rules above have a hole in them.
  const passwords = candidates
    .map(({ connection }) => connection.password)
    .filter((password) => password.length >= 8);

  for (const [key, value] of Object.entries(env)) {
    if (passwords.some((password) => value.includes(password))) {
      delete env[key];
      generatedEnv.push(key);
    }
  }
  for (const [key, value] of Object.entries(databaseEnv)) {
    if (passwords.some((password) => value.includes(password))) {
      delete databaseEnv[key];
      generatedEnv.push(key);
    }
  }

  const engine = describing ? findEngine(describing.database.dbEngine ?? '') : null;

  return {
    name: service.name,
    slug: service.slug,
    blurb: `${service.name}, shared from Derailed.`,
    image: service.image,
    port: service.port,
    volumes: listVolumesFor(service.id).map((volume) => volume.containerPath),
    env: Object.keys(env).length ? env : undefined,
    generatedEnv: generatedEnv.length ? generatedEnv : undefined,
    database:
      describing && engine
        ? {
            engine: describing.database.dbEngine ?? '',
            version: describing.database.dbVersion ?? engine.versions[0] ?? '',
            env: databaseEnv,
          }
        : undefined,
    afterDeploy: 'Open your site to finish setting it up.',
  };
}
