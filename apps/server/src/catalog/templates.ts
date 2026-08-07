import { BlockedAddressError, fetchPublic } from '../util/net.ts';
import { DATABASE_ENGINES } from './databases.ts';
/**
 * One-click apps.
 *
 * The point is that someone who has never heard of an environment variable can put
 * WordPress on the internet. A template knows the image, the port, the storage that
 * has to survive a redeploy, and how to fill in the database details. So nothing is
 * left for the person to work out.
 *
 * Adding one is a data change, not a code change.
 */
export interface TemplateConnection {
  host: string;
  port: number;
  dbName: string;
  user: string;
  password: string;
  url: string;
}

export interface TemplateDatabase {
  engine: 'postgres' | 'mysql' | 'redis';
  version: string;
  /**
   * Maps the created database's connection details onto the variables this app
   * expects. Apps rarely agree on names, and almost none read a DATABASE_URL.
   */
  env: (connection: TemplateConnection) => Record<string, string>;
}

/** The only things a `{placeholder}` in a shared template may stand for. */
export const CONNECTION_FIELDS = [
  'host',
  'port',
  'dbName',
  'user',
  'password',
  'url',
] as const satisfies readonly (keyof TemplateConnection)[];

/**
 * The same mapping, written down rather than computed.
 *
 * A template from the catalogue maps connection details with a function, which is the
 * right shape for code and an impossible one for JSON. A shared template says
 * `"DB_HOST": "{host}"` instead, and only the six names above are ever substituted:
 * anything else in braces is left exactly as it was typed, so a template cannot reach
 * for something it was not offered.
 */
export function fillConnection(
  template: Record<string, string>,
  connection: TemplateConnection,
): Record<string, string> {
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(template)) {
    filled[key] = value.replace(/\{([a-zA-Z]+)\}/g, (whole, field: string) =>
      (CONNECTION_FIELDS as readonly string[]).includes(field)
        ? String(connection[field as keyof TemplateConnection])
        : whole,
    );
  }
  return filled;
}

/**
 * The order they appear in, which is a decision rather than an accident of the array.
 * Agents go first: they are the newest reason to have a server of your own, and the
 * one thing here nobody arrives already knowing they can self-host.
 */
export const CATEGORY_ORDER = ['AI agents', 'Websites', 'Tools', 'Analytics', 'Media'] as const;

export type TemplateCategory = (typeof CATEGORY_ORDER)[number];

export interface AppTemplate {
  slug: string;
  name: string;
  /** One line, in plain language, describing what this is for. */
  blurb: string;
  category: TemplateCategory;
  image: string;
  port: number;
  /** Paths that must outlive a redeploy. */
  volumes: string[];
  /** Fixed variables the image needs regardless of anything else. */
  env?: Record<string, string>;
  /**
   * Variables that must exist but must not be the same on every server: a dashboard
   * password, a signing key. Filled with a fresh random value when the app is
   * created, and visible afterwards in its Variables tab.
   */
  generatedEnv?: string[];
  /**
   * Overrides the image's default command. Only for images that are a toolbox rather
   * than a program: run them with no arguments and they print help and exit.
   */
  command?: string[];
  database?: TemplateDatabase;
  /** Shown after it deploys, what to do next, in one sentence. */
  afterDeploy: string;
  /** Some images take a while to answer on first boot. */
  slowStart?: boolean;
}

export const APP_TEMPLATES: AppTemplate[] = [
  {
    slug: 'wordpress',
    name: 'WordPress',
    blurb: 'The classic website and blog platform. Runs about half the web.',
    category: 'Websites',
    image: 'wordpress:php8.3-apache',
    port: 80,
    volumes: ['/var/www/html/wp-content'],
    database: {
      engine: 'mysql',
      version: '8.4',
      env: (c) => ({
        WORDPRESS_DB_HOST: `${c.host}:${c.port}`,
        WORDPRESS_DB_NAME: c.dbName,
        WORDPRESS_DB_USER: c.user,
        WORDPRESS_DB_PASSWORD: c.password,
      }),
    },
    afterDeploy: 'Open your site and follow the WordPress setup to pick a title and password.',
  },
  {
    slug: 'ghost',
    name: 'Ghost',
    blurb: 'A clean, modern blog and newsletter platform.',
    category: 'Websites',
    image: 'ghost:5-alpine',
    port: 2368,
    volumes: ['/var/lib/ghost/content'],
    env: { NODE_ENV: 'production' },
    database: {
      engine: 'mysql',
      version: '8.0',
      env: (c) => ({
        database__client: 'mysql',
        database__connection__host: c.host,
        database__connection__port: String(c.port),
        database__connection__database: c.dbName,
        database__connection__user: c.user,
        database__connection__password: c.password,
      }),
    },
    afterDeploy: 'Open your site and add /ghost to the address to create your account.',
    slowStart: true,
  },
  {
    slug: 'n8n',
    name: 'n8n',
    blurb: 'Connect your apps together and automate jobs, without writing code.',
    category: 'Tools',
    image: 'n8nio/n8n:latest',
    port: 5678,
    volumes: ['/home/node/.n8n'],
    env: { N8N_PORT: '5678', GENERIC_TIMEZONE: 'UTC' },
    afterDeploy: 'Open it and create the owner account on first use.',
  },
  {
    slug: 'uptime-kuma',
    name: 'Uptime Kuma',
    blurb: 'Watches your websites and tells you the moment one goes down.',
    category: 'Tools',
    image: 'louislam/uptime-kuma:1',
    port: 3001,
    volumes: ['/app/data'],
    afterDeploy: 'Open it, create your account, and add the first thing to watch.',
  },
  {
    slug: 'umami',
    name: 'Umami',
    blurb: 'Privacy-friendly website analytics. A simple alternative to Google Analytics.',
    category: 'Analytics',
    image: 'ghcr.io/umami-software/umami:postgresql-latest',
    port: 3000,
    volumes: [],
    env: { HASH_SALT: 'derailed' },
    database: {
      engine: 'postgres',
      version: '17',
      env: (c) => ({
        DATABASE_TYPE: 'postgresql',
        DATABASE_URL: c.url,
      }),
    },
    afterDeploy: 'Sign in with admin / umami, then change the password straight away.',
    slowStart: true,
  },
  {
    slug: 'vaultwarden',
    name: 'Vaultwarden',
    blurb: 'Your own password manager, compatible with the Bitwarden apps.',
    category: 'Tools',
    image: 'vaultwarden/server:latest',
    port: 80,
    volumes: ['/data'],
    afterDeploy:
      'Open it and create your account. Add a domain with HTTPS before storing anything real.',
  },
  {
    slug: 'nextcloud',
    name: 'Nextcloud',
    blurb: 'Your own Dropbox: files, photos, calendars and contacts, on your server.',
    category: 'Tools',
    image: 'nextcloud:30-apache',
    port: 80,
    volumes: ['/var/www/html'],
    database: {
      engine: 'mysql',
      version: '8.4',
      env: (c) => ({
        MYSQL_HOST: `${c.host}:${c.port}`,
        MYSQL_DATABASE: c.dbName,
        MYSQL_USER: c.user,
        MYSQL_PASSWORD: c.password,
      }),
    },
    afterDeploy: 'Open it and create the admin account. The first start takes a minute or two.',
    slowStart: true,
  },
  {
    slug: 'gitea',
    name: 'Gitea',
    blurb: 'Host your own git repositories, with issues and pull requests.',
    category: 'Tools',
    image: 'gitea/gitea:1',
    port: 3000,
    volumes: ['/data'],
    env: { USER_UID: '1000', USER_GID: '1000' },
    afterDeploy:
      'Open it and finish the short setup form. The defaults are fine; the first account you make is the admin.',
    slowStart: true,
  },
  {
    slug: 'jellyfin',
    name: 'Jellyfin',
    blurb: 'Your own Netflix for the films and music you already own.',
    category: 'Media',
    image: 'jellyfin/jellyfin:latest',
    port: 8096,
    volumes: ['/config', '/cache', '/media'],
    afterDeploy:
      'Open it and follow the setup. Put your files in the media folder from the Storage tab.',
    slowStart: true,
  },
  {
    slug: 'grafana',
    name: 'Grafana',
    blurb: 'Dashboards and graphs for anything you can measure.',
    category: 'Analytics',
    image: 'grafana/grafana-oss:latest',
    port: 3000,
    volumes: ['/var/lib/grafana'],
    afterDeploy: 'Sign in with admin / admin. It asks you to change the password immediately.',
  },
  {
    slug: 'metabase',
    name: 'Metabase',
    blurb: 'Ask questions of your database and get charts back, without writing SQL.',
    category: 'Analytics',
    image: 'metabase/metabase:latest',
    port: 3000,
    volumes: ['/metabase.db'],
    afterDeploy: 'Open it and create your account, then connect it to one of your databases.',
    slowStart: true,
  },
  {
    slug: 'freshrss',
    name: 'FreshRSS',
    blurb: 'Read the sites you follow in one place, with no algorithm in the way.',
    category: 'Media',
    image: 'freshrss/freshrss:latest',
    port: 80,
    volumes: ['/var/www/FreshRSS/data'],
    afterDeploy: 'Open it and follow the setup. SQLite is the simplest choice and works well.',
  },
  {
    slug: 'vikunja',
    name: 'Vikunja',
    blurb: 'Lists, boards and deadlines. A to-do app that is actually yours.',
    category: 'Tools',
    image: 'vikunja/vikunja:latest',
    port: 3456,
    volumes: ['/app/vikunja/files'],
    afterDeploy: 'Open it and register the first account, which becomes the owner.',
  },
  {
    slug: 'mealie',
    name: 'Mealie',
    blurb: 'Keep your recipes, plan meals and build a shopping list.',
    category: 'Tools',
    image: 'ghcr.io/mealie-recipes/mealie:latest',
    port: 9000,
    volumes: ['/app/data'],
    env: { ALLOW_SIGNUP: 'false' },
    afterDeploy: 'Sign in with changeme@example.com / MyPassword, then change both immediately.',
    slowStart: true,
  },
  {
    slug: 'actual',
    name: 'Actual Budget',
    blurb: 'Envelope budgeting for your own money, kept on your own server.',
    category: 'Tools',
    image: 'actualbudget/actual-server:latest',
    port: 5006,
    volumes: ['/data'],
    afterDeploy: 'Open it and set the password that protects your budget.',
  },
  {
    slug: 'listmonk',
    name: 'Listmonk',
    blurb: 'Send newsletters to your own mailing list, without paying per subscriber.',
    category: 'Tools',
    image: 'listmonk/listmonk:latest',
    port: 9000,
    volumes: ['/listmonk/uploads'],
    env: { LISTMONK_app__address: '0.0.0.0:9000' },
    database: {
      engine: 'postgres',
      version: '17',
      env: (c) => ({
        LISTMONK_db__host: c.host,
        LISTMONK_db__port: String(c.port),
        LISTMONK_db__user: c.user,
        LISTMONK_db__password: c.password,
        LISTMONK_db__database: c.dbName,
        LISTMONK_db__ssl_mode: 'disable',
      }),
    },
    afterDeploy:
      'Sign in with listmonk / listmonk and change it, then add your sending server under Settings.',
    slowStart: true,
  },
  {
    slug: 'matomo',
    name: 'Matomo',
    blurb: 'Website analytics with the detail of Google Analytics, kept to yourself.',
    category: 'Analytics',
    image: 'matomo:5-apache',
    port: 80,
    volumes: ['/var/www/html'],
    database: {
      engine: 'mysql',
      version: '8.4',
      env: (c) => ({
        MATOMO_DATABASE_HOST: `${c.host}:${c.port}`,
        MATOMO_DATABASE_DBNAME: c.dbName,
        MATOMO_DATABASE_USERNAME: c.user,
        MATOMO_DATABASE_PASSWORD: c.password,
        MATOMO_DATABASE_ADAPTER: 'mysql',
      }),
    },
    afterDeploy: 'Open it and follow the setup; the database details are filled in already.',
    slowStart: true,
  },
  {
    slug: 'excalidraw',
    name: 'Excalidraw',
    blurb: 'A whiteboard for sketching ideas that look hand-drawn.',
    category: 'Tools',
    image: 'excalidraw/excalidraw:latest',
    port: 80,
    volumes: [],
    afterDeploy: 'Open it and start drawing. Everything stays in the browser you drew it in.',
  },
  {
    slug: 'syncthing',
    name: 'Syncthing',
    blurb: 'Keeps folders in sync across your machines, with no cloud in between.',
    category: 'Tools',
    image: 'syncthing/syncthing:latest',
    port: 8384,
    volumes: ['/var/syncthing'],
    afterDeploy: 'Open it and pair your first device. Put a password on it before adding a domain.',
  },
  {
    slug: 'directus',
    name: 'Directus',
    blurb: 'A friendly admin panel and API for a database you own.',
    category: 'Tools',
    image: 'directus/directus:latest',
    port: 8055,
    volumes: ['/directus/uploads'],
    env: { KEY: 'derailed-key', SECRET: 'derailed-secret' },
    database: {
      engine: 'postgres',
      version: '17',
      env: (c) => ({
        DB_CLIENT: 'pg',
        DB_HOST: c.host,
        DB_PORT: String(c.port),
        DB_DATABASE: c.dbName,
        DB_USER: c.user,
        DB_PASSWORD: c.password,
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'derailed',
      }),
    },
    afterDeploy: 'Sign in with admin@example.com / derailed, then change both in the admin area.',
    slowStart: true,
  },
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    blurb:
      "An AI assistant that runs on your server, not someone else's. Connects to your chat apps.",
    category: 'AI agents',
    image: 'ghcr.io/openclaw/openclaw:latest',
    port: 18789,
    // The workspace lives inside the config directory, so the one volume keeps both.
    volumes: ['/home/node/.openclaw', '/home/node/.config/openclaw'],
    generatedEnv: ['OPENCLAW_GATEWAY_TOKEN'],
    afterDeploy:
      'Open it and sign in with the gateway token from the Variables tab, then add a model provider key to start talking to it.',
    slowStart: true,
  },
  {
    slug: 'hermes-agent',
    name: 'Hermes Agent',
    blurb: 'An AI agent that learns as it works, keeping what it learns on your own machine.',
    category: 'AI agents',
    image: 'nousresearch/hermes-agent:latest',
    // Its entrypoint is the toolbox, not the gateway. Without this it prints help.
    command: ['gateway', 'run'],
    port: 9119,
    volumes: ['/opt/data'],
    env: { HERMES_DASHBOARD: '1', HERMES_DASHBOARD_BASIC_AUTH_USERNAME: 'admin' },
    // The dashboard refuses to serve on anything but loopback unless it has a
    // password, and Derailed always serves it through the proxy. Generated, or the
    // one-click app would deploy successfully and then answer every visitor with 403.
    generatedEnv: ['HERMES_DASHBOARD_BASIC_AUTH_PASSWORD'],
    afterDeploy:
      'Open it and sign in as admin, with the password from the Variables tab. Then add a model provider key so it can think.',
    slowStart: true,
  },
];

/**
 * Which folders this app almost certainly needs to keep, worked out from its image.
 *
 * Used to warn someone before a redeploy quietly deletes their uploads. Getting this
 * wrong in the cautious direction is fine: the worst case is suggesting storage that
 * turns out not to be needed.
 */
export function storageAdviceFor(
  image: string | null,
  framework: string | null,
  /** Included because an app built from a repository has no image name to go on. */
  name?: string | null,
): {
  paths: string[];
  what: string;
} | null {
  const haystack = `${image ?? ''} ${framework ?? ''} ${name ?? ''}`.toLowerCase();
  if (!haystack.trim()) return null;

  const match = APP_TEMPLATES.find(
    (template) =>
      template.volumes.length > 0 &&
      (haystack.includes(template.slug) || haystack.includes(template.image.split(':')[0]!)),
  );
  if (match) {
    return {
      paths: match.volumes,
      what: `${match.name} keeps your content and settings there`,
    };
  }

  // Anything that stores files but isn't one of ours.
  for (const [needle, advice] of KNOWN_STATEFUL) {
    if (haystack.includes(needle)) return advice;
  }
  return null;
}

const KNOWN_STATEFUL: [string, { paths: string[]; what: string }][] = [
  ['nextcloud', { paths: ['/var/www/html/data'], what: 'Nextcloud keeps your files there' }],
  ['gitea', { paths: ['/data'], what: 'Gitea keeps your repositories there' }],
  ['grafana', { paths: ['/var/lib/grafana'], what: 'Grafana keeps your dashboards there' }],
  ['minio', { paths: ['/data'], what: 'MinIO keeps your objects there' }],
  ['jellyfin', { paths: ['/config'], what: 'Jellyfin keeps its library there' }],
];

export function findTemplate(slug: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((template) => template.slug === slug);
}

/**
 * A template from somewhere else.
 *
 * Twenty ready-made apps is a feature; two hundred is a moat, and it is the one part
 * of Derailed other people can build. This is the smallest thing that makes that
 * possible: paste a URL to a template file, get an app.
 *
 * Validated hard, because the file comes from the internet and turns into a container
 * running on somebody's server. Everything is checked by shape, and anything not
 * recognised is dropped rather than passed through: a template that could set
 * arbitrary Docker options would be a way to hand somebody a root shell politely.
 */
export class TemplateError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'TemplateError';
    this.hint = hint;
  }
}

/** A container image, as `name`, `name:tag` or `host/name:tag`. Nothing else. */
function isImageName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 200 &&
    /^[a-z0-9][a-z0-9._\-/]*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/.test(value)
  );
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('..');
}

/**
 * Turns whatever was fetched into a template, or refuses.
 *
 * Only the fields Derailed itself defines survive. A field it does not know is not
 * passed through to Docker on the chance it might be useful; it is dropped, because
 * the difference between those two positions is whether this is a feature or a
 * vulnerability.
 */
export function parseTemplate(input: unknown): AppTemplate {
  if (!input || typeof input !== 'object') {
    throw new TemplateError('That file is not a template.');
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new TemplateError('That template has no name.');
  }
  if (!isImageName(raw.image)) {
    throw new TemplateError(
      'That template does not name a container image Derailed recognises.',
      'It should look like `ghost:5-alpine` or `ghcr.io/someone/thing:1.2`.',
    );
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TemplateError('That template does not say which port the app listens on.');
  }

  const volumes = Array.isArray(raw.volumes) ? raw.volumes.filter(isAbsolutePath) : [];
  const env: Record<string, string> = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      // Names only in the shape an environment variable actually has, and values as
      // text. Anything else is somebody trying something.
      if (/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key) && typeof value === 'string') {
        env[key] = value.slice(0, 4000);
      }
    }
  }

  return {
    database: parseDatabase(raw.database),
    slug: String(raw.slug ?? raw.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60),
    name: raw.name.trim().slice(0, 60),
    blurb: typeof raw.blurb === 'string' ? raw.blurb.slice(0, 200) : 'Added from a link.',
    // Always this one. A template does not get to invent a category and rearrange
    // somebody's catalogue.
    category: 'Tools',
    image: raw.image,
    port,
    volumes,
    env: Object.keys(env).length ? env : undefined,
    generatedEnv: Array.isArray(raw.generatedEnv)
      ? raw.generatedEnv.filter(
          (key): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
        )
      : undefined,
    afterDeploy:
      typeof raw.afterDeploy === 'string'
        ? raw.afterDeploy.slice(0, 300)
        : 'Open your site to finish setting it up.',
  };
}

/**
 * The database half of a shared template, or nothing.
 *
 * Checked as hard as everything else: the engine has to be one of three, the version
 * one the catalogue actually offers, and the mapping plain strings. A template that
 * could name any image and any version would be a way to start an unmaintained
 * database from four years ago on somebody's server.
 */
function parseDatabase(input: unknown): TemplateDatabase | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;

  const engine = raw.engine;
  if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'redis') return undefined;

  const offered = DATABASE_ENGINES.find((entry) => entry.engine === engine);
  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!offered?.versions.includes(version)) return undefined;

  const mapping: Record<string, string> = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key) && typeof value === 'string') {
        mapping[key] = value.slice(0, 4000);
      }
    }
  }

  return { engine, version, env: (connection) => fillConnection(mapping, connection) };
}

/**
 * Fetches and validates one. Everything that can go wrong is said in words.
 *
 * The address comes from whoever pasted it, and the request is made by the server,
 * from inside the network the server sits in. That combination is the whole of what
 * server-side request forgery is, so it goes through `fetchPublic`, which resolves the
 * name before connecting and checks every redirect rather than trusting the first hop.
 *
 * Https only, and that rule is now actually enforced: with `redirect: 'follow'` the
 * check applied to the address somebody typed and to nothing after it, so a link to an
 * ordinary https site that answered `302 Location: http://169.254.169.254/` walked
 * straight past it.
 */
export async function fetchTemplate(url: string): Promise<AppTemplate> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TemplateError(`"${url}" is not a web address.`);
  }

  let response: Response;
  try {
    response = await fetchPublic(
      parsed,
      { signal: AbortSignal.timeout(15_000) },
      { protocols: ['https:'] },
    );
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new TemplateError(
        err.message,
        'A template has to sit somewhere on the public internet over https.',
      );
    }
    throw new TemplateError('That address could not be reached.');
  }
  if (!response.ok) {
    throw new TemplateError(`That address answered ${response.status}.`);
  }

  const text = await response.text();
  // Bounded before parsing: a multi-megabyte JSON document is not a template, and
  // parsing one to find that out is the wrong order.
  if (text.length > 64_000) throw new TemplateError('That file is far too large to be a template.');

  try {
    return parseTemplate(JSON.parse(text));
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw new TemplateError('That file is not readable as a template.');
  }
}
