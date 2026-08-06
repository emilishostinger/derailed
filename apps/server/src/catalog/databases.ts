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
  /**
   * Newest first. The first entry is the default offered in the UI.
   *
   * Only versions worth running for years are listed. MySQL and MariaDB both publish
   * short-lived "innovation" releases alongside their long-term ones, and putting
   * those in front of someone choosing a database for a website they will not think
   * about again is handing them an end-of-life notice in eight months.
   */
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
    versions: ['18', '17', '16', '15'],
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
    engine: 'mariadb',
    label: 'MariaDB',
    // The long-term releases only. 11.8 is supported into 2030.
    versions: ['11.8', '11.4', '10.11'],
    image: (version) => `mariadb:${version}`,
    port: 3306,
    volumePath: '/var/lib/mysql',
    env: (c) => ({
      MARIADB_DATABASE: c.dbName,
      MARIADB_USER: c.user,
      MARIADB_PASSWORD: c.password,
      MARIADB_ROOT_PASSWORD: c.password,
    }),
    urlTemplate: (c) =>
      `mysql://${c.user}:${encodeURIComponent(c.password)}@${c.host}:3306/${c.dbName}`,
    healthCmd: (c) => ['CMD-SHELL', `mariadb-admin ping -h 127.0.0.1 -u${c.user} -p${c.password}`],
    defaultInjectKey: 'DATABASE_URL',
    blurb: "MySQL's community fork. A drop-in replacement for most apps.",
    usesDbName: true,
    usesUser: true,
  },
  {
    engine: 'mongodb',
    label: 'MongoDB',
    versions: ['8', '7'],
    image: (version) => `mongo:${version}`,
    port: 27017,
    volumePath: '/data/db',
    env: (c) => ({
      MONGO_INITDB_ROOT_USERNAME: c.user,
      MONGO_INITDB_ROOT_PASSWORD: c.password,
      MONGO_INITDB_DATABASE: c.dbName,
    }),
    // `authSource=admin` because the root user is created in the admin database, not
    // in the one named here. Without it every driver connects and is then refused.
    urlTemplate: (c) =>
      `mongodb://${c.user}:${encodeURIComponent(c.password)}@${c.host}:27017/${c.dbName}?authSource=admin`,
    healthCmd: () => ['CMD-SHELL', 'mongosh --quiet --eval \'db.adminCommand("ping")\''],
    defaultInjectKey: 'MONGODB_URI',
    blurb: 'Stores documents rather than rows. Common with Node apps.',
    usesDbName: true,
    usesUser: true,
  },
  {
    engine: 'redis',
    label: 'Redis',
    versions: ['8', '7.4', '7.2'],
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
  {
    engine: 'valkey',
    label: 'Valkey',
    versions: ['9', '8'],
    image: (version) => `valkey/valkey:${version}-alpine`,
    port: 6379,
    volumePath: '/data',
    env: (c) => ({ VALKEY_PASSWORD: c.password }),
    // Speaks the Redis protocol, so every Redis client and every `REDIS_URL` works.
    urlTemplate: (c) => `redis://default:${encodeURIComponent(c.password)}@${c.host}:6379`,
    healthCmd: (c) => ['CMD-SHELL', `valkey-cli -a ${c.password} ping | grep -q PONG`],
    defaultInjectKey: 'REDIS_URL',
    blurb: 'Redis under an open licence, by the people who wrote it. Same protocol.',
    usesDbName: false,
    usesUser: false,
  },
];

export function findEngine(engine: string): DatabaseEngine | null {
  return DATABASE_ENGINES.find((entry) => entry.engine === engine) ?? null;
}

/** Redis and Valkey need their password as a command flag, not just an env var. */
export function commandFor(
  engine: DatabaseEngine,
  credentials: DatabaseCredentials,
): string[] | undefined {
  if (engine.engine === 'redis') {
    return ['redis-server', '--requirepass', credentials.password, '--appendonly', 'yes'];
  }
  if (engine.engine === 'valkey') {
    return ['valkey-server', '--requirepass', credentials.password, '--appendonly', 'yes'];
  }
  return undefined;
}
