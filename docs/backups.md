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
