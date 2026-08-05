# The command line

The same binary that serves the dashboard.

```
derailed serve                    Run the server (this is what systemd does)
derailed mcp                      Run as an MCP server for coding agents
derailed setup                    Create the admin account from the command line
derailed update                   Download and install the latest version
derailed reset-password [email]   Set a new password for the admin account
derailed version                  Print the version
derailed help                     Show this
```

## serve

What systemd runs. Starts the HTTP server first, then everything that needs Docker, so
a broken Docker install shows up in the dashboard instead of preventing boot.

On start it also reconciles: containers that should be running are started, ones that
have vanished are marked stopped, and orphans it created are cleaned up.

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

## mcp

Speaks JSON-RPC 2.0 over stdin and stdout for coding agents. Needs `DERAILED_URL` and
`DERAILED_TOKEN`. See [coding agents](mcp.md).

## Environment

| Variable | Default | What it is |
| --- | --- | --- |
| `DERAILED_DATA` | `/var/lib/derailed` | Where everything is kept |
| `DERAILED_PORT` | `8422` | Dashboard port |
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
