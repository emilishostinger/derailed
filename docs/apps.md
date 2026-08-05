# Ready-made apps

**New → Choose a ready-made app** installs one of these with its database, its storage
and its settings already right. It is the same machinery as any other deploy, with the
fiddly parts filled in.

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
| **Gitea** | Your own git repositories, with issues and pull requests | — |
| **Vaultwarden** | A password manager the Bitwarden apps can talk to | — |
| **n8n** | Connect apps together and automate jobs, without code | — |
| **Uptime Kuma** | Watches your sites and tells you when one goes down | — |
| **Vikunja** | Lists, boards and deadlines | — |
| **Mealie** | Recipes, meal plans and a shopping list | — |
| **Actual Budget** | Envelope budgeting, kept on your own server | — |
| **Listmonk** | Newsletters to your own list, without paying per subscriber | PostgreSQL |
| **Excalidraw** | A whiteboard for sketching ideas | — |
| **Syncthing** | Keeps folders in sync between your machines | — |
| **Directus** | An admin panel and API for a database you own | PostgreSQL |

### Analytics

| | What it is | Database |
| --- | --- | --- |
| **Umami** | Privacy-friendly website analytics | PostgreSQL |
| **Matomo** | The detail of Google Analytics, kept to yourself | MySQL |
| **Grafana** | Dashboards and graphs for anything you can measure | — |
| **Metabase** | Ask questions of your database, get charts back | — |

### Media

| | What it is | Database |
| --- | --- | --- |
| **Jellyfin** | Your own Netflix for films and music you own | — |
| **FreshRSS** | Read the sites you follow, with no algorithm in the way | — |

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
