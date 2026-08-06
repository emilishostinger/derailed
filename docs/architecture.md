# Architecture

For anyone changing the code, and anyone deciding whether to trust it.

## The shape of it

```
  systemd ──▶ derailed            one binary: API, dashboard, build pipeline, MCP
              ├── SQLite          /var/lib/derailed/derailed.db
              ├── Docker Engine   unix:/var/run/docker.sock
              └── Caddy admin     127.0.0.1:2019

  Docker
   ├── derailed-caddy             ports 80/443, certificates, access log
   ├── your apps                  one container per running deploy
   └── your databases             one container each, private to their project
```

Derailed runs on the host, not in a container. Two reasons: it must keep working when
Docker does not, which is exactly when someone needs to read the error; and putting the
thing that manages Docker inside Docker makes upgrades and socket access harder for no
gain.

## One binary

`bun build --compile` produces a single executable with the API, the React dashboard,
the build pipeline and the MCP server inside it. The dashboard is built by Vite and
embedded with `with { type: 'file' }` imports generated at build time.

There is nothing to install alongside it: no Node, no Python, no package manager.
Cross-compiling for a server is `bun run build --target=linux-x64`.

## Data

SQLite through `bun:sqlite`, with numbered migrations applied at startup. The database
holds projects, services, deploys, domains, volumes, links, sessions, tokens, settings
and the rolled-up traffic figures.

Secrets (database passwords, repository tokens, environment variable values) are
encrypted with AES-256-GCM using a key in `/var/lib/derailed/secret.key`. API tokens
are stored only as SHA-256 hashes.

## Docker

A hand-rolled REST client over the Unix socket, `fetch(url, { unix })`. No dockerode,
no shelling out for the things that matter. Around 300 lines, and every response shape
it depends on is in one file.

Everything Derailed creates is labelled `derailed.managed=true`, plus the project,
service and deploy it belongs to. Nothing unlabelled is ever touched, so a machine
running other containers is safe.

## Building

```
clone or unpack → detect → build → start → health check → route → retire the old one
```

Detection reads the checkout and picks: a Dockerfile if there is one, a framework it
recognises, a plain website (HTML or PHP, served by nginx or Apache from a generated
Dockerfile), or Nixpacks.

Nixpacks emits BuildKit cache mounts, which the classic builder cannot parse, so they
are stripped from the generated Dockerfile. Every repository without a Dockerfile
failed until that was found on a real server.

Images are built through the Engine's `/build` endpoint with a tar stream of the
context, which respects `.dockerignore` and never writes a temporary Dockerfile
anywhere the app can see.

## Routing

Caddy owns port 80 and 443. Derailed owns Caddy's configuration: it synthesises the
whole config from the database and pushes it to the admin API. No incremental patching,
so the config cannot drift, and the synthesis is a pure function that is
snapshot-tested without Docker.

A hostname is only included once there is something to send traffic to, and, unless it
is an sslip.io style address, once DNS actually points here, so Caddy never asks for a
certificate it cannot get.

## Live updates

A WebSocket carries deploy progress, log lines, status changes and container stats.
Subscriptions are per topic (`project:ID`, `service:ID`, `system`). The dashboard never
polls.

Container status comes from Docker events plus a monitor loop; databases have no
deploys, so their status is derived from what Docker says is running rather than from a
deploy record.

## Layout

```
apps/server/src/
  analytics/     access log → counters
  backup/        archives, restore, schedule
  build/         detect, nixpacks, site, pipeline, upload, zip, and the two
                 watchers that deploy on their own: pushes and releases
  catalog/       databases and ready-made apps
  db/            schema, migrations, repositories
  docker/        client, containers, images, networks, volumes, labels
  events/        the pub/sub bus behind the WebSocket
  http/          routes, auth, errors
  mcp/           the MCP server and its tools
  proxy/         Caddy config synthesis, DNS checks, the domain watcher
  runtime/       monitor, reconcile, presentation
  system/        status, stats, updates, other software
apps/web/src/    the dashboard
packages/shared/ types and schemas both sides agree on
```

## Conventions

- **Comments explain why, not what.** If a line needs explaining, the comment says what
  went wrong the last time it was written differently.
- **Errors are written for a person.** `FriendlyError` carries a message, a hint and
  optional detail, and the HTTP layer passes all three through.
- **No silent failure.** If something is skipped, it is reported.
- **Tests cover the things that broke.** Several test names describe an incident.

## Verifying

```sh
bun run typecheck
bun run lint
bun test          # integration tests skip themselves without a Docker socket
```

The Docker and Caddy integration tests use their own container names, network and
ports, so running the suite never touches a real installation on the same machine.
