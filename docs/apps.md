# Ready-made apps

**New → Choose a ready-made app** installs one of these with its database, its storage
and its settings already right. It is the same machinery as any other deploy, with the
fiddly parts filled in.

## One from a link

**New → Ready-made apps → "Have a link to one? Paste it here."**

Somebody can publish a template file and send you the address of it, and you get the
app it describes. Over https only.

It checks before it does anything. Paste the link, press **Check it**, and it tells you
what the file says it would create; nothing happens on your server until you press
**Set this up**. "Run this file from the internet on my machine" is not a thing to do on
the strength of a URL nobody has read.

Every field Derailed does not define is dropped rather than passed through, and the
file is size-capped before it is even parsed.

## Sharing one of yours

Any app that runs a published image has **Download the template** on its Overview tab.
It writes a `.derailed.json` file describing the app: the image, the port, the storage,
the variables, and the database if it has one. Put it in a repository, send somebody the
link to the raw file, and they get your app.

Apps built from a repository cannot be shared this way, and it says so. A template names
an image anybody can pull; an app built from source is shared by sharing the source.

### The secrets are taken out

The file is generated from the app's own variables, which is exactly where its
passwords, keys and tokens live, and whoever presses the button is about to publish it.
So three things happen on the way out:

- Anything that came from the app's **database** becomes a placeholder. The password,
  the host, the connection URL: `{password}`, `{host}`, `{url}`. Matched by value rather
  than by variable name, so it is caught even inside a longer string, and matched
  longest-first so a URL stays one placeholder rather than a URL with a hole in it.
- Anything that **looks like a secret** becomes a name instead of a value, listed under
  `generatedEnv`. The installing server fills each one with a fresh random value. Both
  the name and the value are checked: a variable called `LICENCE` holding thirty random
  characters is a key, whatever it is called.
- Anything **Derailed injected** is dropped entirely. A connection string pointing at a
  container on this machine is no use on somebody else's and should not travel.

That is a careful set of rules and not a guarantee. **Read the file before you publish
it.** Anything left in it is a value Derailed had no reason to think was a secret.

### The database half

A shared template describes its database declaratively, because a template from the
catalogue maps connection details with a function and JSON cannot hold one:

```json
"database": {
  "engine": "mysql",
  "version": "8.0",
  "env": { "DB_HOST": "{host}", "DB_PASSWORD": "{password}" }
}
```

Only `{host}`, `{port}`, `{dbName}`, `{user}`, `{password}` and `{url}` are ever
substituted. Anything else in braces is left as typed, so a template cannot reach for
something it was not offered. The engine has to be one of the three and the version one
the catalogue actually offers, or the database block is dropped.


## What is in the catalogue

### Websites

| | What it is | Database |
| --- | --- | --- |
| **WordPress** | The classic website and blog platform | MySQL |
| **Ghost** | A clean, modern blog and newsletter platform | MySQL |

### Tools

| | What it is | Database |
| --- | --- | --- |
| **Nextcloud** | Files, photos, calendars and contacts, on your server | MySQL |
| **Gitea** | Your own git repositories, with issues and pull requests | none |
| **Vaultwarden** | A password manager the Bitwarden apps can talk to | none |
| **n8n** | Connect apps together and automate jobs, without code | none |
| **Uptime Kuma** | Watches your sites and tells you when one goes down | none |
| **Vikunja** | Lists, boards and deadlines | none |
| **Mealie** | Recipes, meal plans and a shopping list | none |
| **Actual Budget** | Envelope budgeting, kept on your own server | none |
| **Listmonk** | Newsletters to your own list, without paying per subscriber | PostgreSQL |
| **Excalidraw** | A whiteboard for sketching ideas | none |
| **Syncthing** | Keeps folders in sync between your machines | none |
| **Directus** | An admin panel and API for a database you own | PostgreSQL |

### Analytics

| | What it is | Database |
| --- | --- | --- |
| **Umami** | Privacy-friendly website analytics | PostgreSQL |
| **Matomo** | The detail of Google Analytics, kept to yourself | MySQL |
| **Grafana** | Dashboards and graphs for anything you can measure | none |
| **Metabase** | Ask questions of your database, get charts back | none |

### Media

| | What it is | Database |
| --- | --- | --- |
| **Jellyfin** | Your own Netflix for films and music you own | none |
| **FreshRSS** | Read the sites you follow, with no algorithm in the way | none |

## What installing one does

1. Creates the database if the app needs one, with a generated password.
2. Creates the app from its official image.
3. Attaches storage to the folders that must outlive a redeploy.
4. Wires the database credentials in as environment variables.
5. Deploys it, and tells you what to do next in one sentence.

Some take a minute or two to answer on first boot while they set themselves up.
Derailed waits longer for those rather than calling the deploy failed.

## Afterwards

- **Set a password immediately** on anything whose first sign-in is a default. The card
  says which those are.
- **Add a domain** before putting anything real in a password manager or a file store.
  A temporary address is plain HTTP.
- **Turn on backups** for the project. These apps hold the sort of data that is
  annoying to lose.

## Updating one

Apps run from an image grow an **Updates** tab. When the image's publisher ships a new
build, updating it is three promises kept in order:

1. **A copy first.** The whole project is backed up before anything is pulled, and the
   backup lands on the Backups page like any other. If the copy cannot be taken, the
   update does not start.
2. **Checked before it takes over.** The new version starts beside the old one and only
   receives traffic once it answers. If it never answers, it is thrown away and the old
   version keeps serving; nothing was ever down.
3. **The way back, written down.** The version that was running is recorded exactly, by
   digest rather than by tag, because after an update the tag means the new version.
   One press on **Put it back the way it was** re-runs it.

Backup-before-update is not a setting; it is what updating is. The one toggle is
**Update automatically from now on**: checked daily, per app, off until you turn it on,
and every automatic update keeps the same three promises.

Putting it back re-runs the old program, not the old data. If the update wrote
something the old version cannot read, the backup from step one restores the data too.

Apps deployed from a repository do not have this tab: for them, updating is deploying,
and every deploy already keeps the previous build to roll back to.

## Which of these have actually been run

Honest answer, because "we support twenty apps" is easy to write and harder to mean.

WordPress, Ghost, Umami, Uptime Kuma, n8n, Vaultwarden, Gitea and Excalidraw have been
installed on a real server from this catalogue and came up. The rest follow the same
pattern from their official images with the configuration their own documentation
gives, but have not each been run end to end.

If one misbehaves it will be an environment variable, and it is a two-line fix in
`apps/server/src/catalog/templates.ts`. Pull requests adding apps are welcome, with the
same rule: only add one you have actually run.

## Adding your own

Anything with a Docker image can be added without touching the catalogue: **New → Run a
Docker image**, then add storage and variables by hand. The catalogue is a convenience,
not a gate.
