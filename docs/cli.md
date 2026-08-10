# The command line

The same binary that serves the dashboard.

```
derailed serve                    Run the server (this is what systemd does)
derailed mcp                      Run as an MCP server for coding agents
derailed setup                    Create the admin account from the command line
derailed update                   Download and install the latest version
derailed doctor                   Check everything and say what is wrong
derailed status                   What is running, and whether it is up
derailed deploy <app>             Deploy an app now
derailed logs <app>               What an app last printed
derailed reset-password [email]   Set a new password for the admin account
derailed version                  Print the version
derailed help                     Show this

# From your laptop, after: derailed login <https://your-server>
derailed login <url>              Save a server address and an API token
derailed dev [--port N]           Share this folder (or a local dev server) on a
                                  temporary subdomain of the server
derailed tunnel <db> [--port N]   Reach a database at 127.0.0.1, no port opened
```

## From your laptop

Three commands run on your own machine and reach the server over the network, unlike
every other command, which runs on the box. They read one small config written by
`derailed login`, stored at `~/.derailed/config.json` (mode 600): the server's address
and an API token you made in Settings. `DERAILED_URL` and `DERAILED_TOKEN` override the
file, for CI.

### derailed dev

```
cd my-site
derailed dev                 # serves this folder
derailed dev --port 5173     # or forwards to a dev server already running
```

Your laptop holds one websocket to the server. The server gives you a throwaway
subdomain, routes it through the proxy to itself, and forwards every request that
arrives on it down the socket to your machine, which answers. The result is a real
HTTPS URL (under your [app base domain](domains.md)'s wildcard, or plain HTTP off an
sslip.io name on a bare box) that shows a client the work-in-progress without anything
being deployed or stored. Close the terminal and the subdomain is gone.

### derailed tunnel

```
derailed tunnel blog-db              # opens 127.0.0.1:6543
derailed tunnel blog-db --port 5555  # or a port you pick
```

Opens a local port that reaches the database over the same kind of websocket. Point
TablePlus, `psql` or anything else at `127.0.0.1`, and no port is ever opened to the
internet: the server dials the database over the network it already shares with it,
and every byte crosses a connection the token check and the audit log have seen. It is
the opposite of the "expose to the internet" button, and it is the one you almost
always want.

## serve

What systemd runs. Starts the HTTP server first, then everything that needs Docker, so
a broken Docker install shows up in the dashboard instead of preventing boot.

On start it also reconciles: containers that should be running are started, ones that
have vanished are marked stopped, and orphans it created are cleaned up.

## status, deploy, logs

For the times you are already in a terminal on the box.

```sh
derailed status              # every project and app, and whether it is up
derailed deploy blog         # queue a deploy
derailed logs blog           # the last 200 lines it printed
```

An app can be named by its own name, its short name, or `project/app` when two
projects both have something called `web`. An ambiguous name is reported rather than
guessed at: deploying the wrong app because two were called the same thing is not a
mistake worth making on anybody's behalf.

`status` asks Docker directly rather than reading the dashboard's own idea of what is
running, which lives in the memory of the serving process and would be empty here.

## doctor

Runs the same checks as the **Server** page: Docker, the router, disk, memory, swap,
the clock, your domains, certificates and backups. Every line either says it is fine or
says what to do.

```
derailed doctor
```

Exits `1` when something needs attention and `0` otherwise, so it works as a cron job
or a monitoring check without anything having to parse the output.

This exists for the case where the dashboard is the thing that is broken, which is
exactly when a health check is worth having and exactly when a web page cannot give you
one.

## reset-password

The way back in when the password is lost. Asks twice, ends every existing session,
and changes nothing if the two do not match.

```sh
derailed reset-password
derailed reset-password you@example.com    # when there is more than one account
```

## setup

Creates the first account without a browser, for unattended installs. Refuses if an
account already exists.

## update

Fetches the newest release, replaces the binary in place and tells you to restart.

```sh
derailed update && systemctl restart derailed
```

Your apps keep running throughout: they are containers, and Derailed is not in the
request path once traffic is flowing.

## uninstall

Puts the machine back the way the installer found it. The apps and databases
Derailed runs, their volumes, its own data under `/var/lib/derailed`, the service,
and the binary all go. Docker itself stays, since other things may use it by now.

```sh
derailed uninstall          # asks you to type "uninstall" first
derailed uninstall --yes    # does not ask
```

There is no undo. Backups that were written to another machine survive, everything
on this one does not. Anything that refuses to be removed is named on the way out
so you can finish the job by hand.

## mcp

Speaks JSON-RPC 2.0 over stdin and stdout for coding agents. Needs `DERAILED_URL` and
`DERAILED_TOKEN`. See [coding agents](mcp.md).

## Environment

| Variable | Default | What it is |
| --- | --- | --- |
| `DERAILED_DATA` | `/var/lib/derailed` | Where everything is kept |
| `DERAILED_PORT` | `1337` | Dashboard port |
| `DERAILED_HOST` | `0.0.0.0` | Address to listen on |
| `DERAILED_URL` | | Which server `derailed mcp` talks to |
| `DERAILED_TOKEN` | | An API token, created in Settings |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket |
| `DERAILED_CADDY_HTTP` | `80` | Public HTTP port |
| `DERAILED_CADDY_HTTPS` | `443` | Public HTTPS port |
| `DERAILED_CADDY_IMAGE` | `caddy:2-alpine` | The proxy image |
| `DERAILED_CADDY_NAME` | `derailed-caddy` | Its container name |
| `DERAILED_CADDY_NETWORK` | `derailed` | The shared network |
| `DERAILED_CADDY_ADMIN` | `2019` | Caddy's admin port, bound to loopback |
| `DERAILED_DEV` | | Development mode: high ports, no root needed |
| `DERAILED_BIN` | `$DERAILED_DATA/bin` | Where the Nixpacks builder is cached |
| `DERAILED_REPO` | | Which GitHub repository `update` fetches from |

Set them in the systemd unit:

```ini
[Service]
Environment=DERAILED_PORT=9000
```

## Reading the logs

```sh
journalctl -u derailed -f            # follow
journalctl -u derailed -n 200        # the last 200 lines
```

Deploy output also lives in the dashboard, per deploy, and outlives the container.
