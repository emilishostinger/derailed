# Storage

The single most important page here, because getting it wrong loses data quietly.

## What survives a deploy

A deploy builds a new image and starts a **new container**. Anything the old container
wrote to its own filesystem goes with it. That is how containers work, and it is
usually what you want: it is why a deploy is repeatable.

It is not what you want for uploads, a SQLite file, or anything a person typed in.

**Storage** attaches a Docker volume at a path inside the container. What is written
there lives on the server, outside any container, and survives deploys, restarts,
rollbacks and image updates.

## Adding it

The **Storage** tab of an app: give the path inside the container, for example
`/app/data` or `/var/www/html/wp-content`. The next deploy mounts it.

Storage attached to an app that is already running takes effect on the next deploy, not
immediately. The tab says so, and a backup will tell you the same thing rather than
quietly copying an empty folder.

## The warning

Derailed knows which images and frameworks almost certainly write data (WordPress,
Ghost, n8n, SQLite-backed apps and others) and warns before a deploy that would
destroy it:

> This app looks like it keeps data in `/var/www/html/wp-content`, and no storage is
> attached. Deploying replaces the container and that folder goes with it.

You can deploy anyway, once you have read it. The warning is deliberately in the way,
because the alternative is finding out afterwards.

## Ready-made apps

Apps from the [catalogue](apps.md) come with the right storage already attached. That is
most of the value of installing them that way.

## What is stored where

Volumes are named `derailed-v-<service id>` (or `derailed-data-…` for older ones) and
live where Docker keeps volumes, normally `/var/lib/docker/volumes`. You can look at
them with `docker volume ls`, and Derailed only ever touches ones it created.

To copy files in or out, the app's **Terminal** tab is usually easiest. From the server:

```sh
docker cp ./local-file CONTAINER:/app/data/
docker cp CONTAINER:/app/data/thing ./
```

## Removing storage

Detaching a volume on the Storage tab stops it being mounted; the data stays on the
server until you delete it, and Derailed says which it is doing.

Deleting the app does **not** delete its volumes. The app goes to the [trash](trash.md)
for a week with its storage intact, and only then is any of it removed. Emptying the
trash by hand does it sooner, and says so first.

**Deleting storage is an owner's decision**, like deleting the app it belongs to. It was
a member's until 0.9.0, which had the line in the wrong place: an app can be deployed
again from the same link in a minute, and the database inside its storage cannot be got
back at all. Members can still attach storage and detach it, which is the part that is
reversible. See [more than one person](people.md).

## Backups

Stored folders are what a [backup](backups.md) copies, as a plain `.tar` per folder
inside the archive. Restoring one stops the app first, replaces the files and starts it
again. A folder emptied underneath a running app looks fine until the next restart,
which is exactly the kind of surprise this is meant to avoid.
