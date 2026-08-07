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

Building things is half of it. The other half is what you get asked next, and every
one of these used to mean leaving the editor and opening the dashboard:

| Tool | What it does |
| --- | --- |
| `get_metrics` | Processor and memory by the hour, with deploys marked. The way to answer "when did this start" |
| `list_domains` | Every address, which app answers on it, whether DNS points here, whether it has a certificate |
| `check_domain` | Look a domain up again now, after changing a record, rather than waiting |
| `list_backups` | What copies exist, how big, and what the schedule keeps |
| `back_up_now` | Back a project up immediately, off-site copy included |
| `list_jobs` | Scheduled jobs, when each runs in words, and how the last few went |
| `add_job` | Schedule a command, in an app or on the server itself |
| `run_job` | Run one now, without waiting for its schedule |
| `get_job_runs` | What a job printed the last few times |
| `run_command` | Run one command inside an app or database and get its output |

`run_command` is the one that is not a straight translation of an endpoint. The Terminal
tab is an interactive shell over a websocket, which is not a shape an agent can use:
there is no session to hold and no prompt to read. So it borrows a scheduled job, which
already knows how to run one command inside a container and capture what it printed, runs
it once, and deletes it. The schedule it is given is the thirty-first of February, so it
cannot fire on its own in the moment between being created and being removed.

It works on databases as well as apps, which is deliberate: `psql`, `mysqldump` and a
one-off index rebuild all live inside a database container.

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
