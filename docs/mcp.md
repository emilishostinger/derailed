# Coding agents (MCP)

Derailed ships an [MCP](https://modelcontextprotocol.io) server, so a coding agent
(Claude Code, Cursor, Codex, or anything else that speaks the protocol) can deploy
apps, read logs and add domains for you while you work.

## Setting it up

1. **Coding agents → Create an access key.** It is shown once and stored
   only as a hash, so there is no way to recover it later.
2. Copy the configuration block shown next to it into your agent. It looks like this:

```json
{
  "mcpServers": {
    "derailed": {
      "command": "derailed",
      "args": ["mcp"],
      "env": {
        "DERAILED_URL": "https://panel.example.com",
        "DERAILED_TOKEN": "drl_…"
      }
    }
  }
}
```

The `derailed` binary needs to be on the machine running the agent, which is usually
your laptop rather than the server. It talks to `DERAILED_URL` over the API; nothing is
run locally.

## What it can do

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project with its apps, databases, statuses and addresses |
| `server_status` | Docker, the proxy, disk, memory and load |
| `create_project` | Make a project |
| `deploy_from_github` | Create an app from a repository link and deploy it |
| `install_app` | Install one of the ready-made apps, database and storage included |
| `list_available_apps` | What is in the catalogue |
| `add_database` | Add PostgreSQL, MySQL or Redis |
| `deploy` | Deploy or redeploy an app |
| `control_service` | Start, stop or restart |
| `get_logs` | Build output or runtime logs |
| `get_variables` / `set_variables` | Read and write environment variables |
| `add_domain` | Point a domain at an app |
| `add_storage` | Attach a folder that survives redeploys |

Everything an agent does through these is the same as doing it in the dashboard: the
same checks, the same warnings, the same audit trail in the deploy log.

## What it deliberately cannot do

There is no tool for deleting a project, a service or a domain, and none for restoring
a backup. Those are the actions where a misunderstanding is expensive and the
confirmation matters, so they stay in the dashboard where a person is looking at them.

## Tokens

- Prefixed `drl_`, 32 random bytes, stored as a SHA-256 hash.
- Full access to the API. Treat one like the password.
- Listed in Settings with when each was last used, and revocable individually.
- A revoked key stops working immediately.

## Without an agent

`derailed mcp` speaks JSON-RPC 2.0 over stdin and stdout, so anything that can spawn a
process can use it. The same operations are available over [the API](api.md) if you
would rather use HTTP.
