# The API

Everything the dashboard does, it does through this. There is no private API.

Base URL is your dashboard's address plus `/api`.

## Authenticating

Two ways in.

**An API token**, for scripts and agents. Create one in Settings → Coding agents (MCP).

```sh
curl -H "Authorization: Bearer drl_…" https://panel.example.com/api/projects
```

**A session cookie**, which is what the dashboard itself uses. Cookie requests must
also carry `X-Requested-With: derailed`; a request without it is refused, which is what
stops another site making one on your behalf.

Errors come back as:

```json
{ "error": { "code": "bad_request", "message": "Plain language.", "hint": "What to do." } }
```

## Projects

| | |
| --- | --- |
| `GET /projects` | Every project, with services, statuses, domains and links |
| `POST /projects` | `{ name }` |
| `GET /projects/:id` | One project |
| `PATCH /projects/:id` | `{ name }` |
| `DELETE /projects/:id` | Removes the project and everything in it |
| `POST /projects/:id/services` | Create an app or database (see below) |
| `POST /projects/:id/templates` | `{ slug }`, installs a ready-made app |

Creating a service:

```jsonc
// an app from a repository
{ "kind": "app", "name": "shop", "repoUrl": "https://github.com/you/shop", "branch": "main" }
// an app from an image
{ "kind": "app", "name": "proxy", "source": "image", "image": "caddy:2-alpine", "port": 80 }
// an app you will upload a zip to
{ "kind": "app", "name": "site", "source": "upload" }
// a database
{ "kind": "database", "name": "db", "engine": "postgres", "version": "17" }
```

## Services

| | |
| --- | --- |
| `GET /services/:id` | One service |
| `PATCH /services/:id` | Branch, folder, port, health path, memory limit, image, and `deployOnPush` / `deployOnRelease` |
| `DELETE /services/:id` | Stops it and frees its addresses. Everything stored is kept for a week; see the trash below |
| `POST /services/:id/start` · `/stop` · `/restart` | Control it |
| `GET · PUT · POST /services/:id/snapshots` | Copies of one database: list, set the interval, take one now |
| `GET /services/:id/snapshots/at?at=` | Which copy would be used for a moment, without restoring |
| `POST /services/:id/snapshots/:snapshotId/restore` | Puts one back, into the database the snapshot belongs to. The `:id` and the snapshot must agree. No undo |
| `GET /services/:id/template` | This app as a `.derailed.json` template file. Secrets are placeheld or renamed on the way out |
| `GET /services/:id/files?path=` | Browse an app's storage. Apps only: a database keeps its data in storage too, and its raw files are not a thing to hand-edit or stream out, so every `files` route refuses one |
| `GET /services/:id/files/read?path=` · `PUT /services/:id/files` | Read and write one file, as text, up to 512 KB |
| `GET /services/:id/files/download?path=` | Stream one file out, as bytes |
| `POST /services/:id/files/upload?path=&name=` | The file **is** the request body, up to 200 MB. Replaces one of the same name, and lands owned by whoever owns the folder |
| `POST /services/:id/files/folder` · `/files/rename` | `{ path, name }`. `name` is a name, never a path |
| `DELETE /services/:id/files?path=` | Deletes a file, or a folder and everything in it. No undo |
| `GET /services/:id/update` | What is running, whether the registry has something newer, past updates, and whether "put it back" has anywhere to go |
| `POST /services/:id/update` | Backs the project up, pulls the new image, deploys it, and checks it answers. Answers `202` at once; the update reports over the socket. Image-run apps only |
| `POST /services/:id/update/revert` | Re-runs the exact version (by digest) recorded before the last update. Data is not rolled back |
| `PUT /services/:id/auto-update` | `{ enabled }`. Checked daily; every automatic update takes the same backup first |
| `GET /services/:id/upgrade` | Which versions this database can move up to, and how past moves went |
| `POST /services/:id/upgrade` | `{ version }`. Copy first, new engine on a fresh volume, reload, verify; the old engine is kept stopped for a week. Answers `202`; progress over the socket |
| `GET /services/:id/pitr` · `PUT` | The point-in-time archive: whether it is on, how far back it reaches, what it costs in disk. Postgres only; `PUT { enabled }` rebuilds the container either way |
| `POST /services/:id/pitr/restore` | `{ at }` in epoch milliseconds. Winds the database back to that moment; what it holds now is kept for a week. Answers `202`; the outcome lands as a notice |
| `GET /services/:id/bots` · `PUT` | The bot walls: `{ mode: off\|polite\|strict, blockAi }`, plus how many addresses are currently challenged or refused |
| `GET /services/:id/login` · `PUT` | Accounts in front of the app: `{ enabled, allowedEmails }`, plus who is signed in right now. Sessions are named by an id, never by their cookie |
| `DELETE /services/:id/login/sessions/:sessionId` | Signs that browser out the moment it next asks |
| `GET /services/:id/messages` | What the site's forms received, newest first, with `limit` and `offset` |
| `PUT /services/:id/messages/settings` | `{ enabled }`: whether the proxy catches this app's form posts |
| `DELETE /services/:id/messages/:messageId` | Deletes one message |
| `GET /services/:id/messages/export` | Everything as CSV, formula-defused |
| `GET /services/:id/mail` · `PUT` | Whether this app may send email |
| `GET /services/:id/sleep` · `PUT` · `POST /services/:id/wake` | Pause when quiet, and wake it |
| `PUT /services/:id/access` | Password, `allowFrom`, `blockFrom`, maintenance. The password is hashed and never returned. Blocking your own address is refused once; send `force: true` to mean it |
| `GET /system/my-address` | The address this request arrived from, for the "add mine" button |
| `POST /services/:id/upload` | `multipart/form-data` with `file`, a zip, up to 200 MB |
| `PUT /services/:id/repo-token` | `{ token }` for a private repository, or `null` to clear |
| `GET /services/:id/env` · `PUT` | Environment variables. The values are secrets, so a viewer cannot read them; a member or owner can |
| `GET /services/:id/traffic?range=24h\|7d\|30d` | Visitor figures |
| `GET /services/:id/connection` | Database credentials and ready-made commands. Holds the password in the clear, so not for a viewer |
| `GET /services/:id/tables` | `{ kind, tables }`. `kind` is `sql`, `documents` or `keys`, and decides which of the rest apply |
| `GET /services/:id/tables/:table?limit=&offset=` | A page of one table or collection, with `primaryKey` and a total |
| `PUT /services/:id/tables/:table/cell` | `{ key, column, value }`. One cell. `value: null` is a real null |
| `POST /services/:id/query` | `{ body }`. Reads only, per engine. `{ sql }` still works |
| `GET · PUT · DELETE /services/:id/collections/:name/:documentId` | One MongoDB document, as JSON. `PUT` replaces it whole |
| `GET /services/:id/keys?pattern=&cursor=` | A slice of keys with type and expiry. Cursor-paged, because it is `SCAN` |
| `GET · PUT /services/:id/keys/value` | One key. Only a plain string can be written |
| `DELETE /services/:id/keys?key=` | Deletes a key |
| `GET · POST /services/:id/queries` · `DELETE /services/:id/queries/:queryId` | Queries kept against this database |
| `GET /services/:id/links` | What this app is connected to |
| `GET /services/:id/volumes` · `POST` | Storage |
| `DELETE /volumes/:id` | Removes storage, and what is in it. Owner only |
| `GET /services/:id/domains` · `POST` | Its addresses |

## Importing

| | |
| --- | --- |
| `POST /import/inspect` | `{ repoUrl, branch?, rootDir?, format? }`. Clones shallowly, reads whatever the repository carries, a compose file, `app.json` + `Procfile`, `render.yaml`, `railway.json` or `fly.toml`, and answers with a plan, its warnings, and which formats were found. Creates nothing |
| `POST /projects/:id/import` | `{ plan }` from inspect, possibly edited. Databases first, then services in dependency order with storage, variables and aliases, then the wiring and the schedules, then the deploys in the same order |

## Off-site backups and drills

| | |
| --- | --- |
| `GET /backups/offsite` | Where copies are sent, and what is there. Never the secret |
| `PUT /backups/offsite` | Set it. Omit `secretAccessKey` to keep the stored one |
| `DELETE /backups/offsite` | Stop copying, and forget the credentials |
| `POST /backups/offsite/test` | Write a file, read it back, compare, delete |
| `GET /backups/drill` | The most recent proof that a backup can be read back |
| `POST /backups/drill` | Check one now. `{ backupId }`, or the newest |

## Previews

`PUT /services/:id/previews` also takes `data: 'shared' | 'clone'` and `scrub`, the
optional command run against each copy before it serves.

| | |
| --- | --- |
| `GET /system/adoptable` · `POST /system/adopt` | Things already on this machine, and taking one over |
| `GET /system/cost` | What everything running would cost on a platform that sends a bill |
| `GET /system/previews` | Whether screenshots are switched on |
| `PUT /system/previews` | `{ screenshots }`. Off by default; on means downloading a browser |
| `POST /services/:id/preview` | Refresh one app's title, icon and picture now |
| `GET /services/previews/:name` | The image itself. Behind the session, like everything |

## Scheduled jobs

| | |
| --- | --- |
| `GET /jobs` · `GET /services/:id/jobs` | Everything scheduled, or one app's. Server jobs are listed to owners only |
| `POST /jobs` | `{ serviceId, name, command, schedule }`. A null serviceId runs on the server, and is owner only |
| `PATCH /jobs/:id` · `DELETE /jobs/:id` | Change or remove one. Owner only for a server job |
| `POST /jobs/:id/run` | Run it now, whatever the schedule says. Owner only for a server job |
| `GET /jobs/:id/runs` | The last twenty runs, with what they printed. Owner only for a server job |
| `POST /jobs/preview` | `{ schedule }` in words, and when it would next fire |

A job with a `serviceId` runs inside that app's container and is a member's to make. A
job without one runs as a shell command on the machine, so every route above is owner
only when the job has no app attached. See [jobs](jobs.md#jobs-that-belong-to-the-server).

## Moving servers

| | |
| --- | --- |
| `GET /backups/move/plan` | Everything Derailed knows, minus the secrets |
| `POST /backups/move/export` | Build the file: the plan plus a backup of every project |
| `POST /backups/move/import` | `{ plan }`. Recreates the shape, starts nothing |

## Signing in

| | |
| --- | --- |
| `POST /auth/login` | `{ email, password, code? }`. Answers `{ needsCode: true }` when one is set up. A body of the wrong shape is a 400 |
| `POST /auth/totp/start` · `/totp/confirm` | Set up the second factor. Confirm returns recovery codes, once |
| `DELETE /auth/totp` | `{ password }`. The password again, deliberately |
| `GET /auth/sessions` · `DELETE /auth/sessions/:id` | Where you are signed in |
| `GET /audit` | Who changed what, for the last year |

## Uptime

| | |
| --- | --- |
| `GET /uptime` | Every watched address, with ninety days of history |
| `POST /uptime/:domainId/check` | Check one now |
| `PUT /uptime/status-page` | `{ enabled, title }` |
| `GET /public/status.json` | The public page. No session. 404 until switched on |

## Alerts

| | |
| --- | --- |
| `GET /alerts` | Channels and what is switched on. Secrets never included |
| `PUT /alerts/channels` | Replace the list. A blank secret keeps the stored one |
| `PUT /alerts/events` | Which kinds of thing are worth a message |
| `POST /alerts/channels/:id/test` | Send a real message to one channel, now |
| `POST /alerts/test` | Send a test to every channel |

## Health

| | |
| --- | --- |
| `GET /system/doctor` | Run every check and report |
| `POST /system/doctor/fix/:action` | Put one thing right. `restart-proxy`, `reclaim-disk` or `add-swap` |

## The machine's disk

| | |
| --- | --- |
| `GET /system/disk` | What is using the disk, by category, with what could be freed |
| `POST /system/disk/reclaim` | Remove unused images, build scraps and stopped containers |
| `GET /system/swap` | Whether this server has swap, and whether it should |
| `POST /system/swap` | Create a swap file and turn it on. `{ bytes }`, or the suggested size |

## Templates

| | |
| --- | --- |
| `POST /templates/from-url` | `{ url }`. Fetches and validates a template, and shows it before anything is created |

## The trash

Deleting is undoable for seven days. See [trash](trash.md).

| | |
| --- | --- |
| `GET /trash` | What is still recoverable, and what each item still holds |
| `POST /trash/:kind/:id/restore` | Put it back. `kind` is `project` or `service` |
| `DELETE /trash/:kind/:id` | Empty this one now. Irreversible |

## Deploys

| | |
| --- | --- |
| `GET /services/:id/deployments` | History |
| `POST /services/:id/deployments` | Deploy now |
| `GET /deployments/:id` | One deploy |
| `GET /deployments/:id/logs?tail=1000` | Its output |
| `POST /deployments/:id/rollback` | Re-run this deploy's image |
| `POST /deployments/:id/cancel` | Stop one in flight |
| `GET /deployments/:id/why` | What went wrong and what to do, plus the lines worth reading |
| `GET /deployments/:id/changes` | What changed since the version before. Variable names, never values |
| `GET /deployments/:id/search?q=&errors=` | Search one deploy's log, or filter it to errors |
| `GET /services/:id/metrics?range=24h\|7d\|30d` | Load, an hour at a time, with the deploys marked |

## Domains

| | |
| --- | --- |
| `GET /domains` | Every address on the server |
| `PUT /projects/:id/limits` | `{ memoryLimitMb, cpuLimitMillis }`, per app in the project. Null for no limit |
| `GET · PUT /projects/:id/env` | Variables shared by every app in the project. An app's own value wins. `PUT` takes `{ vars: [{ key, value }] }` and replaces the lot, so an absent `vars` is a 400 rather than "delete them all" |
| `GET · POST /webhooks` · `PATCH · DELETE /webhooks/:id` | Where to POST events. Owner only. The signing secret is never returned |
| `POST /webhooks/:id/test` | Sends one through the ordinary path, signature included |
| `GET /system/ports` | Every port open to the internet, with what each is for |
| `GET /system/traffic?range=` | Every app's traffic added up, with a per-app breakdown |
| `GET · PUT /updates/automatic` · `POST /updates/automatic/run` | Unattended security updates: state, switch, run now |
| `POST /domains` | `{ hostname, alsoAddWww, primary: "apex" \| "www" }`. A name that resolves to a different machine is refused once; send `force: true` to mean it |
| `PUT /domains/:id/service` | `{ serviceId }` or `{ serviceId: null }` |
| `PUT /domains/:id/primary` | Swap which half of a pair people see |
| `PUT /domains/:id/path` | `{ pathPrefix }`. Null is the whole domain |
| `POST /domains/:id/check` | Check DNS now |
| `DELETE /domains/:id` | Remove it |

## Backups

| | |
| --- | --- |
| `GET /backups` | Copies, schedules, retention and when the last run was |
| `POST /backups` | `{ projectId }` |
| `PUT /backups/schedule` | `{ projectId, schedule: "off" \| "daily" \| "weekly" }` |
| `PUT /backups/retention` | `{ keep, keepDays }`. Owner only: saving prunes across every project at once |
| `GET /backups/:id/download` | The `.tar.gz` itself. Owner only: it holds every database in the project in full, so it is as sensitive as the token list |
| `POST /backups/:id/restore` | `{ projectId }`. Owner only: it writes over what is there now. 404 if there is no such copy |
| `DELETE /backups/:id` | Remove a copy. 404 if there is no such copy |

## The machine

| | |
| --- | --- |
| `GET /system` | Version, Docker, proxy, disk, whether setup is done |
| `GET /system/stats` | CPU, memory, load, with a plain-language summary |
| `GET /system/others` | Derailed itself, and containers it did not create |
| `PATCH /system` | `{ serverIp }`, or `null` to detect it again |
| `GET /system/panel-domain` · `PUT` | The dashboard's own domain |
| `GET /system/app-domain` · `PUT` | The base domain for automatic addresses |
| `GET /updates` · `POST /updates/:id/apply` | What is out of date, and applying it |
| `GET /services/:id/previews` · `PUT` | A copy of the app per branch |
| `GET /catalog/databases` · `GET /templates` | What can be created |
| `GET /tokens` · `POST` · `DELETE /tokens/:id` | API tokens |

## People

| | |
| --- | --- |
| `GET /people` | Everyone, and which one is you |
| `POST /people` | `{ email, password, role }` |
| `PUT /people/:id/role` | `{ role }` |
| `DELETE /people/:id` | Removes them, and their sessions |

Owners only, reads included. Everything else in this reference is refused to a viewer on
any method but `GET`, and refused to a member where it changes the server itself.

Two edges to that rule, both because the shape of a request does not always tell you what
it hands back or reaches:

- **A handful of reads are still owner-or-member, not viewer.** A `GET` that returns a
  live secret rather than a view of one is not a viewer's: an app's variables
  (`GET /services/:id/env`), a database's connection string (`GET /services/:id/connection`),
  and a backup archive (`GET /backups/:id/download`, which is every database in the
  project). A viewer is the role for a client or for showing somebody a problem, and none
  of those should walk out with the keys.
- **A handful of member-shaped writes are owner-only.** Publishing a database to the
  internet (`POST /services/:id/expose`) opens a port on the machine; downloading,
  restoring or pruning backups moves or overwrites the data itself. Making and deleting an
  individual backup, and scheduling them, stay a member's.

## Accounts

| | |
| --- | --- |
| `GET /auth/status` | Whether the server has been set up |
| `POST /auth/setup` | First account only |
| `POST /auth/login` · `POST /auth/logout` | Sessions |
| `GET /auth/me` | Who you are |
| `PATCH /auth/me/email` | `{ email, password }` |
| `PATCH /auth/me/password` | `{ current, password }`, ends every other session |

Sign-in is rate limited to five attempts a minute per address.

## Live updates

`GET /api/ws` upgrades to a WebSocket carrying deploy progress, log lines, status
changes and stats. Subscribe by sending `{"subscribe": ["project:ID"]}`. The dashboard
never polls; it listens.

`GET /api/terminal?service=ID` upgrades to a shell inside a running container.
