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
| `GET /services/:id/files?path=` | Browse an app's storage |
| `GET /services/:id/files/read?path=` · `PUT /services/:id/files` | Read and write one file |
| `GET /services/:id/mail` · `PUT` | Whether this app may send email |
| `PUT /services/:id/access` | Password, address list, maintenance. The password is hashed and never returned |
| `POST /services/:id/upload` | `multipart/form-data` with `file`, a zip, up to 200 MB |
| `PUT /services/:id/repo-token` | `{ token }` for a private repository, or `null` to clear |
| `GET /services/:id/env` · `PUT` | Environment variables |
| `GET /services/:id/traffic?range=24h\|7d\|30d` | Visitor figures |
| `GET /services/:id/connection` | Database credentials and ready-made commands |
| `GET /services/:id/tables` | The tables in a database, with rough row counts |
| `GET /services/:id/tables/:table` | A page of one table |
| `POST /services/:id/query` | `{ sql }`. Statements that read, and nothing else |
| `GET /services/:id/links` | What this app is connected to |
| `GET /services/:id/volumes` · `POST` | Storage |
| `GET /services/:id/domains` · `POST` | Its addresses |

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

| | |
| --- | --- |
| `GET /system/cost` | What everything running would cost on a platform that sends a bill |
| `GET /system/previews` | Whether screenshots are switched on |
| `PUT /system/previews` | `{ screenshots }`. Off by default; on means downloading a browser |
| `POST /services/:id/preview` | Refresh one app's title, icon and picture now |
| `GET /services/previews/:name` | The image itself. Behind the session, like everything |

## Scheduled jobs

| | |
| --- | --- |
| `GET /jobs` · `GET /services/:id/jobs` | Everything scheduled, or one app's |
| `POST /jobs` | `{ serviceId, name, command, schedule }`. A null serviceId runs on the server |
| `PATCH /jobs/:id` · `DELETE /jobs/:id` | Change or remove one |
| `POST /jobs/:id/run` | Run it now, whatever the schedule says |
| `GET /jobs/:id/runs` | The last twenty runs, with what they printed |
| `POST /jobs/preview` | `{ schedule }` in words, and when it would next fire |

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
| `POST /domains` | `{ hostname, alsoAddWww, primary: "apex" \| "www" }` |
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
| `PUT /backups/retention` | `{ keep, keepDays }` |
| `GET /backups/:id/download` | The `.tar.gz` itself |
| `POST /backups/:id/restore` | `{ projectId }` |
| `DELETE /backups/:id` | Remove a copy |

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
| `GET /catalog/databases` · `GET /templates` | What can be created |
| `GET /tokens` · `POST` · `DELETE /tokens/:id` | API tokens |

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
