/**
 * Declarative database catalog. Each entry fully describes an engine, so adding
 * MariaDB or Mongo later is a data change, not a code change.
 */
export interface DatabaseCredentials {
  host: string;
  dbName: string;
  user: string;
  password: string;
}

export interface DatabaseEngine {
  engine: string;
  label: string;
  /** Newest first. The first entry is the default offered in the UI. */
  versions: string[];
  image: (version: string) => string;
  port: number;
  volumePath: string;
  env: (credentials: DatabaseCredentials) => Record<string, string>;
  urlTemplate: (credentials: DatabaseCredentials) => string;
  healthCmd: (credentials: DatabaseCredentials) => string[];
  defaultInjectKey: string;
  /** One line the UI shows on the engine card. */
  blurb: string;
  /** Some engines have no concept of a database name or user. */
  usesDbName: boolean;
  usesUser: boolean;
}

export const DATABASE_ENGINES: DatabaseEngine[] = [
  {
    engine: 'postgres',
    label: 'PostgreSQL',
    versions: ['17', '16', '15'],
    image: (version) => `postgres:${version}-alpine`,
    port: 5432,
    volumePath: '/var/lib/postgresql/data',
    env: (c) => ({
      POSTGRES_DB: c.dbName,
      POSTGRES_USER: c.user,
      POSTGRES_PASSWORD: c.password,
      PGDATA: '/var/lib/postgresql/data/pgdata',
    }),
    urlTemplate: (c) =>
      `postgres://${c.user}:${encodeURIComponent(c.password)}@${c.host}:5432/${c.dbName}`,
    healthCmd: (c) => ['CMD-SHELL', `pg_isready -U ${c.user} -d ${c.dbName}`],
    defaultInjectKey: 'DATABASE_URL',
    blurb: 'The usual choice. Great for almost anything.',
    usesDbName: true,
    usesUser: true,
  },
  {
    engine: 'mysql',
    label: 'MySQL',
    versions: ['8.4', '8.0'],
    image: (version) => `mysql:${version}`,
    port: 3306,
    volumePath: '/var/lib/mysql',
    env: (c) => ({
      MYSQL_DATABASE: c.dbName,
      MYSQL_USER: c.user,
      MYSQL_PASSWORD: c.password,
      MYSQL_ROOT_PASSWORD: c.password,
    }),
    urlTemplate: (c) =>
      `mysql://${c.user}:${encodeURIComponent(c.password)}@${c.host}:3306/${c.dbName}`,
    healthCmd: (c) => ['CMD-SHELL', `mysqladmin ping -h 127.0.0.1 -u${c.user} -p${c.password}`],
    defaultInjectKey: 'DATABASE_URL',
    blurb: 'Widely supported, especially by PHP apps.',
    usesDbName: true,
    usesUser: true,
  },
  {
    engine: 'redis',
    label: 'Redis',
    versions: ['7'],
    image: (version) => `redis:${version}-alpine`,
    port: 6379,
    volumePath: '/data',
    env: (c) => ({ REDIS_PASSWORD: c.password }),
    urlTemplate: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:6379`,
    healthCmd: (c) => ['CMD-SHELL', `redis-cli -a ${c.password} ping | grep -q PONG`],
    defaultInjectKey: 'REDIS_URL',
    blurb: 'In-memory store for caching, queues and sessions.',
    usesDbName: false,
    usesUser: false,
  },
];

export function findEngine(engine: string): DatabaseEngine | null {
  return DATABASE_ENGINES.find((entry) => entry.engine === engine) ?? null;
}

/** Redis needs its password passed as a command flag, not just an env var. */
export function commandFor(
  engine: DatabaseEngine,
  credentials: DatabaseCredentials,
): string[] | undefined {
  if (engine.engine === 'redis') {
    return ['redis-server', '--requirepass', credentials.password, '--appendonly', 'yes'];
  }
  return undefined;
}
