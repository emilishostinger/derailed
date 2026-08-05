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
| `PATCH /services/:id` | Branch, folder, port, health path, memory limit, image |
| `DELETE /services/:id` | Removes it, its containers and its volumes |
| `POST /services/:id/start` · `/stop` · `/restart` | Control it |
| `POST /services/:id/upload` | `multipart/form-data` with `file`, a zip, up to 200 MB |
| `PUT /services/:id/repo-token` | `{ token }` for a private repository, or `null` to clear |
| `GET /services/:id/env` · `PUT` | Environment variables |
| `GET /services/:id/traffic?range=24h\|7d\|30d` | Visitor figures |
| `GET /services/:id/connection` | Database credentials and ready-made commands |
| `GET /services/:id/links` | What this app is connected to |
| `GET /services/:id/volumes` · `POST` | Storage |
| `GET /services/:id/domains` · `POST` | Its addresses |

## Deploys

| | |
| --- | --- |
| `GET /services/:id/deployments` | History |
| `POST /services/:id/deployments` | Deploy now |
| `GET /deployments/:id` | One deploy |
| `GET /deployments/:id/logs?tail=1000` | Its output |
| `POST /deployments/:id/rollback` | Re-run this deploy's image |
| `POST /deployments/:id/cancel` | Stop one in flight |

## Domains

| | |
| --- | --- |
| `GET /domains` | Every address on the server |
| `POST /domains` | `{ hostname, alsoAddWww, primary: "apex" \| "www" }` |
| `PUT /domains/:id/service` | `{ serviceId }` or `{ serviceId: null }` |
| `PUT /domains/:id/primary` | Swap which half of a pair people see |
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
