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


## Looking inside

Every database has a **Browse** tab. All six of them.

Three of these engines keep rows, one keeps documents and two keep keys, and pretending
those are the same thing produces a screen that is wrong for all of them. So the
questions are the same and the shape of the answer changes.

### Tables (PostgreSQL, MySQL, MariaDB)

The tables, roughly how many rows each has, and a page of whichever one you pick, fifty
at a time with a count of the whole.

**Click a cell to change it.** Enter saves, Escape leaves it alone, and there is a
`Set to null` for when empty is not what you mean. Only the cell you edited is written,
so a timestamp your application maintains is not quietly rewritten alongside it.

Editing needs a primary key, because without one there is no way to say which row you
mean. A table without one is shown and says so rather than offering an edit that would
change an unknown number of rows.

Pages are ordered by that primary key. Without an order a database returns rows in
whatever order it finds them, which is not stable: on PostgreSQL an edited row
physically moves to the end of the table, so it would vanish from the page you were
looking at and reappear on the last one.

A null and an empty string are shown differently, because the difference is usually the
thing you opened this screen to check.

### Documents (MongoDB)

The collections, and a page of documents flattened into a grid: the columns are the
field names that appear on that page, and a document without one is blank rather than
empty. Nested objects and arrays are shown as their JSON, because a document five levels
deep expanded into columns is a table hundreds wide and less readable than the JSON was.

Click an `_id` to open that document as JSON and edit it. It is saved whole, so a field
you delete in the editor really goes.

### Keys (Redis, Valkey)

A key browser: the keys, what type each one holds, and how long until it expires. Filter
with a pattern like `session:*`.

Open one to see what is in it. A plain string can be edited in place, keeping whatever
expiry it already had. A list, hash, set or sorted set is shown but not edited, because
changing one member through a text box is a way to lose its position or its score.

Keys are walked with `SCAN`, a slice at a time. Never `KEYS *`, which blocks the server
for as long as it takes to walk every key: a screen whose whole purpose is looking
should not be able to take a site down.

### Asking a question

Every kind has a box:

```sql
select count(*) from users where created_at > '2026-01-01'
```
```js
db.orders.find({ status: "pending" })
```
```
hgetall session:abc
```

**It only runs things that read.** For SQL that is `select`, `show`, `describe`,
`explain` and `with`. For MongoDB, `find`, `findOne`, `aggregate`, `countDocuments` and
their relatives. For Redis and Valkey, an allowlist of reading commands.

Each is an allowlist rather than a search for dangerous ones, because a denylist is a
guess about every way somebody could write `DROP`, and being wrong once means losing a
database. A second statement smuggled in after a semicolon is refused for the same
reason. `KEYS` is refused too, even though it only reads.

To change data beyond what the grid allows, use the **Terminal** tab, where the engine's
own client is one command away and it is obvious what you are doing.

### Queries worth keeping

**Keep it** saves a query under a name. The query you actually want is the same three
every time, and retyping them from memory is the reason people give up and install a
client instead.

They are kept against the database rather than against you: the useful ones are facts
about the shape of the data, and whoever looks after it next should find them already
there.

### How it works

Nothing is bundled to make any of this work. It runs the database's own `psql`, `mysql`,
`mongosh` or `valkey-cli` inside the database's own container, the same way backups do.
No driver in the binary, no port opened, nothing new listening.

Values you type are sent as hex rather than quoted into the statement, so there are no
escaping rules to get wrong and a cell containing `'); DROP TABLE users; --` is a cell
containing that text. Table and column names are checked against the ones the database
itself reported, rather than escaped.
