# Databases

Six engines, in one click, private by default.

| Engine | Versions | Port | Default database | Default user |
| --- | --- | --- | --- | --- |
| PostgreSQL | 18, 17, 16, 15 | 5432 | named after the service | `derailed` |
| MySQL | 8.4, 8.0 | 3306 | named after the service | `derailed` |
| MariaDB | 11.8, 11.4, 10.11 | 3306 | named after the service | `derailed` |
| MongoDB | 8, 7 | 27017 | named after the service | `derailed` |
| Redis | 8, 7.4, 7.2 | 6379 | none | none |
| Valkey | 9, 8 | 6379 | none | none |

Only long-term releases are offered. MySQL and MariaDB both publish short-lived
"innovation" versions alongside them, and picking one of those for a website you will
not think about again means an end-of-life notice in eight months.

Valkey is Redis under an open licence, from the people who wrote Redis, and speaks the
same protocol. Every Redis client works against it unchanged, which is why Derailed
injects it as `REDIS_URL` rather than inventing a variable no library reads.

## Creating one

**New → Add a database**, pick the engine and version, name it. Derailed pulls the
image, generates a password, creates a volume for the data and starts it with a health
check.

Names that a database server keeps for itself (`mysql`, `postgres`, `sys` and the
information schemas) get a suffix, because putting your tables inside the server's own
bookkeeping is how a fresh start silently wipes them.

## Connecting an app to it

Drag from the app to the database in the topology view, or use the **Connections** tab.

Derailed injects the connection as an environment variable on the app: `DATABASE_URL`
for PostgreSQL, MySQL and MariaDB, `MONGODB_URI` for MongoDB, `REDIS_URL` for Redis and
Valkey. The value is the full URL, using the database container's name on the project's
private network. Applying it needs a redeploy, which the tab says.

Disconnecting removes the variable. The database keeps its data.

## Getting at it yourself

The **Connection** tab shows the host, port, database, user, password and a ready-made
URL, plus the exact `psql`, `mysql` or `redis-cli` command. Passwords are encrypted at
rest and shown only when you ask.

The **Terminal** tab gives you a shell inside the container, which is usually the
fastest way to run a query or import a dump.

## Reaching it from outside

Databases are private by default: they listen only on their project's Docker network,
so nothing outside can connect. That is the right default and it is worth keeping.

If you need an external connection, for a desktop client or a migration tool, the settings
let you publish a port. Do it deliberately, use the firewall, and turn it off
afterwards. A database on the open internet is found by scanners within hours.

The safer route is an SSH tunnel from your own machine:

```sh
ssh -N -L 5432:127.0.0.1:PUBLISHED_PORT root@your-server
```

## Backups

A database is included in its project's [backup](backups.md) as a SQL dump, which
restores into any later version of the same engine and opens in any tool you already
have. The raw data folder is deliberately not copied as well: it is the same content
again at several times the size, and far more brittle.

MongoDB is kept as a gzipped `mongodump` archive, which `mongorestore` reads back.

Redis and Valkey have no textual dump, so a snapshot of the data is kept instead.
Derailed can copy one out but not put one back, and says so when you restore rather
than failing part-way through: a cache is the one thing on a server that is meant to
be rebuildable.

## Storage

Every database gets a volume for its data folder, created with it. Nothing you need to
do, and a redeploy of the app in front of it does not touch it.

If you delete a database, its volume goes with it, and the data is gone. Derailed asks
you to type the name first.
