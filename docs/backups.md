# Backups

A backup is an ordinary `.tar.gz` file. That is the point: if Derailed ever goes away,
or you want to move to another machine, everything in one of these opens with tools you
already have.

## What is in one

```
manifest.json                    what this is, when, and from which project
databases/
  mysql-dump.sql                 one SQL dump per database
volumes/
  wordpress_var_www_html_wp-content.tar    one tar per stored folder
```

Databases are kept as SQL dumps rather than raw data folders. A dump restores into any
later version of the same engine and can be read by anything; a copied data folder is
the same content at several times the size and far more brittle.

## Making one

**Backups** lists every project. Open one and either back it up now, or set it to run
on its own **every day** or **every week**. The schedule is per project, because "back
up everything" and "back up the one that matters" are both reasonable and only you know
which is which.

The projects list marks which projects are looked after, so the answer to "is this one
safe" is visible without opening anything.

## How much is kept

At the bottom of the Backups page: how many copies to keep per project, and optionally
an age limit in days. Whichever removes a copy first wins, and the newest copy of a
project is never removed for being old, however long it has been.

Both limits apply to copies made by hand as well as scheduled ones, so "keep three"
means three.

## Restoring

Restore replaces what is in the chosen project with what is in the backup. Anything
newer is overwritten, which the dialog says before you agree.

Restoring does this:

1. Databases are restored by feeding the SQL dump to the running server.
2. For each stored folder, the app is **stopped**, the folder is replaced, and the app
   is started again.

That stop is not optional. Emptying a folder underneath a running app leaves it serving
from files that no longer exist: it looks fine until the next restart, and then
everything is gone. An earlier version of this did exactly that.

Anything in the backup with no matching service today is reported rather than silently
skipped, because a partial restore nobody knows about is worse than a failed one.

## Warnings

A backup tells you when a stored folder came out empty, and why:

> wordpress has storage set up at /var/www/html/wp-content, but it is not in use until
> the app is deployed again. Nothing from that folder is in this copy.

A copy nobody questions is the one that turns out to be empty on the day it matters.

## Taking one away

**Download** gives you the `.tar.gz`. Keep it somewhere that is not this server: a
backup on the same disk as the thing it protects is not a backup.

To inspect one:

```sh
tar tzf derailedpress-2026-08-05T10-48-49.tar.gz
tar xzOf backup.tar.gz ./manifest.json | jq
```

## What is not included

- **The Derailed database itself.** Projects, domains and settings live in
  `/var/lib/derailed/derailed.db`. Copy that folder separately.
- **Images.** They are rebuilt from the repository or pulled again.
- **Anything an app wrote outside its stored folders**, which is the same data a deploy
  would have destroyed anyway. See [storage](storage.md).


## Getting them off this server

A backup on the same disk as the thing it is backing up is a copy, not a backup. The
failure that actually loses people's data is losing the whole machine: the disk fails,
the provider closes the account, somebody rebuilds the wrong server. In every one of
those the local `.tar.gz` files go at the same moment as the originals.

**Backups → Send a copy somewhere else.** Any S3-compatible storage works, which in
practice means almost everything cheap:

| Provider | Roughly |
| --- | --- |
| Backblaze B2 | $6 per TB per month, 10 GB free |
| Cloudflare R2 | $15 per TB per month, no charge to download |
| Wasabi, Storj, Hetzner | Similar |
| MinIO on another machine | Free, and yours |
| Amazon S3 | Works, and is the most expensive of these |

Fill in the address, bucket, region and keys. Leave **Put the bucket in the path**
switched on unless you are using Amazon; every other provider expects it, and getting
it wrong produces a "bucket not found" error that has nothing to do with the bucket.

### The Test button

It writes a small file, reads it back, checks it matches, and deletes it.

All four are separate permissions, and a provider will happily accept keys that can
write and not read. Testing only the write is how somebody finds out on the worst
possible day that their backups were never readable. If any step fails, the message
says which one and what it means.

### What gets copied

Every backup, as soon as it is made, scheduled or by hand. The number kept off-site
matches the number kept locally, so setting "keep 7" keeps 7 in both places.

The secret key is encrypted at rest like every other secret and is never sent back to
the browser. Saving the form without retyping it keeps the stored one.

## Proving a backup restores

Every backup tool tells you a backup was made. Almost none tell you it can be read
back, and the gap between those two is where people lose everything: a truncated
archive, a database dump that failed half way and was kept anyway, a stored folder
that was empty when it was copied.

Once a month Derailed opens the newest backup and checks it, without touching anything
that is running:

- The archive unpacks
- The manifest inside it is readable
- Every file the manifest names is present and not empty
- Every database dump ends with the marker its engine writes when a dump completes

Then it deletes the unpacked copy. The result is on the Backups page: **"This backup
restores. 4 items checked, all complete."** Or, if not, exactly what is wrong with it.

**Check now** runs it on demand.

### What it does not do

It stops short of restoring into a live database, which would need a container per
engine and several minutes. It catches every failure seen in practice and is cheap
enough to run unattended, which a full restore would not be.

Engines whose dumps have no end marker (Redis, MongoDB's archive format) are checked
for being present and non-empty and no further. Claiming more than that would be a lie.

## Copies of one database, taken often

A project backup runs nightly. "The bad thing happened at three o'clock and the backup
is from midnight" is the worst hour of somebody's month, and the answer to it is not a
better nightly backup, it is more of them.

Every database has a **Copies** tab: take one now, or have one taken every hour, six
hours or twelve. Forty-eight are kept, so at hourly that is two days.

Putting one back replaces what is in the database now with what was in it then.
Everything written since is gone, which is the point, and there is no undo. Apps
connected to the database keep running; they simply see the older data.

### This is not point-in-time recovery, and the difference matters

Real point-in-time recovery replays a write-ahead log to any second you name. It needs
the database configured to archive that log, it costs disk continuously, and it exists
for PostgreSQL and MySQL and not for the other four engines here.

This puts back the nearest copy taken **at or before** the moment you name. So the
question it answers is "how much do I lose", and the answer is up to one interval
rather than up to a day.

**Never a later copy**, however much closer in time it might be. If the mistake was at
02:55, the 03:00 copy is five minutes away and the 02:00 copy is fifty-five, and the
03:00 one contains the mistake. That is the single rule this whole feature turns on.

### What can be put back

PostgreSQL, MySQL, MariaDB and MongoDB. Redis and Valkey can have a copy taken but not
put back into a running server: their dump is the file the server reads when it starts,
not something it can be handed while running, and the backups page says the same.

The dump is taken with the drops included, so it can go back into the database it came
from rather than only into an empty one. Without that, every `CREATE TABLE` fails
because the table is already there, the client carries on to the next statement, and
the restore reports success while changing nothing at all.
