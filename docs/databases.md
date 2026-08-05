# Databases

PostgreSQL, MySQL and Redis, in one click, private by default.

| Engine | Versions | Port | Default database | Default user |
| --- | --- | --- | --- | --- |
| PostgreSQL | 17, 16, 15 | 5432 | named after the service | `derailed` |
| MySQL | 8.4, 8.0 | 3306 | named after the service | `derailed` |
| Redis | 7 | 6379 | none | none |

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
for PostgreSQL and MySQL, `REDIS_URL` for Redis. The value is the full URL, using the
database container's name on the project's private network. Applying it needs a
redeploy, which the tab says.

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

Redis has no textual dump, so its append-only file is kept instead.

## Storage

Every database gets a volume for its data folder, created with it. Nothing you need to
do, and a redeploy of the app in front of it does not touch it.

If you delete a database, its volume goes with it, and the data is gone. Derailed asks
you to type the name first.
