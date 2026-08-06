# Questions people ask

### Where does the name come from?

It's a joke about things going off the rails, which is what self-hosting usually feels like.
Derailed is an independent open-source project and isn't affiliated with anyone.

Repositories without a Dockerfile are built by [Nixpacks](https://nixpacks.com), an excellent
open-source builder. Credit where it's due.

### How is this different from Coolify or Dokploy?

Mostly scope and taste. Derailed is one binary with no dependencies to install, and it aims at
someone who has never opened a terminal: every screen is in plain language, and the dangerous
actions explain themselves before you take them. If you want a very large feature surface today,
those projects are further along.

### Do I need to know Docker?

No. You need a server and a GitHub link. Derailed uses Docker underneath, and you can always drop
to `docker` on the box if you want to, everything it creates is labelled `derailed.managed=true`.

### Can it deploy private repositories?

Yes. Add a fine-grained GitHub token with read access on the app's Settings tab. It is encrypted at
rest and never sent back to the browser.

### Does it auto-deploy when I push?

Yes, once you ask it to. **Settings → Deploy automatically → Every push to your branch**
on the app, and from then on pushing is all you do: the running app catches up within
about two minutes.

There is no webhook to set up, no public URL and no shared secret, so it also works on a
server GitHub cannot reach. And because it asks git rather than GitHub, it works the same
against GitLab, Bitbucket, Gitea or your own git server.

If pushing and shipping are meant to be separate decisions, the same setting offers
**Only when I publish a release** instead: ordinary commits are ignored and tagging a
release is what deploys. See [deploying](deploying.md).

### Do I need a mail provider for the update emails?

Probably, and Derailed checks rather than guessing.

**Settings** offers two ways to send. *From this server* needs nothing set up: Derailed
hands the message straight to the recipient's mail server. It also tests whether that
will work before offering it, because two things have to be true and on most rented
servers neither is. Outbound port 25 has to be open, and nearly every provider blocks
it by default to stop spam leaving their network. And the server's address needs a
reverse DNS name, or receivers refuse the message before reading it. Both are things
your host can turn on, usually by asking.

*Through a mail provider* is the other way, and there is a list of the usual ones, so
picking Gmail or Fastmail or Resend fills in the server and the port and leaves you
with a username and a password. Most of those want an app password rather than the
one you sign in with, which the page says at the point you need to know it.

Otherwise, hit Deploy (or `⌘K` → "Deploy …"), or have a coding agent do it through
[MCP](mcp.md).

### Will it tell me when there are updates?

If you ask it to. **Settings** has update emails: give it a mail server to send
through and an address to send to, and it emails when the list of pending updates
changes, at most once a day. Optionally only for security updates.

It sends when the set of updates *changes*, not every day, because a daily email
saying the same three packages are still waiting is an email nobody reads by the end
of the week.

### Can I deploy without GitHub at all?

Yes, two ways. Drag in a zip: a folder of HTML is served as it is, a folder of PHP gets PHP and
Apache, and anything else is built as a repository would be. Or give a Docker image name.

### What languages does it support?

Anything with a Dockerfile. Without one, Nixpacks handles Node, Python, Go, Rust, PHP, Ruby, Deno,
Java, Elixir and static sites. Derailed tells you what it detected before it builds anything.

### Can I get HTTPS without buying a domain?

Yes. **Settings → A secure address, free** walks you through claiming a free name from
[DuckDNS](https://www.duckdns.org), which takes about a minute, and every app then gets
an address like `shop.my-server.duckdns.org` with a real certificate.

The reason this works when the ready-made sslip.io addresses cannot be secured is that
`duckdns.org` is on the [public suffix list](https://publicsuffix.org) and `sslip.io` is
not. Let's Encrypt therefore gives your DuckDNS name its own certificate allowance,
instead of counting it against the single global one that every sslip.io address in the
world shares and routinely exhausts.

Derailed asks for one wildcard certificate covering every app at once, proved over DNS,
so adding an app later needs no certificate and no waiting. See
[domains](domains.md#without-a-domain-but-with-a-padlock).

### Where does my data live?

On your server, and nowhere else. Derailed makes exactly two kinds of outbound request on its
own: it asks `api.ipify.org` for your public address at boot, and it resolves DNS over Cloudflare
and Google when checking a domain you added. There is no telemetry, and the update check only
runs when you press the button.

Two more happen only if you ask for them. Claiming a [free secure address](domains.md) tells
DuckDNS which address to point your name at, and asks Let's Encrypt for the certificate; after
that both are contacted again only to renew, twice a day at most. Nothing about your apps, your
visitors or their contents is included in either.

The visitor figures are counted by the proxy on your own machine, so there is no third party in
your pages and nothing to consent to. See [visitor figures](analytics.md).

### Do I get analytics?

Yes, per app, without adding anything to your pages. Visits, people, data sent, reply times, the
pages people read and where they came from. It is counted from the proxy's own log, which is
turned into figures and discarded.

### Are my secrets safe?

Environment variables and database passwords are encrypted at rest with AES-256-GCM, using a key at
`/var/lib/derailed/secret.key` (mode 600). Honestly: that protects the database file if it's copied
off the box. It does not protect against someone who already has root. Nothing running on the
machine can.

### Can I run more than one server?

Not yet. One server, one admin. Multi-server is explicitly out of scope for now.

### Are my apps backed up?

Only if you say so. Each project can be backed up daily or weekly, and you choose how many copies
to keep. A backup is an ordinary `.tar.gz` you can download and open anywhere. See
[backups](backups.md).

### Can I put the dashboard on a domain?

Yes, and you should. Out of the box the dashboard is served over plain HTTP on port 8422, which
means your password crosses the internet unencrypted every time you sign in.

In **Settings → Dashboard address**, point a subdomain (say `dashboard.example.com`) at your server
with an A record and enter it. Derailed checks the record resolves to this machine before switching,
then routes the panel through Caddy with a real certificate. `http://` is redirected to `https://`.

Once that works, close port 8422 in your firewall so the panel is only reachable over HTTPS.
Alternatively, keep 8422 closed from the start and reach it over an SSH tunnel:
`ssh -L 8422:localhost:8422 root@your-server`.

### What happens to my apps when Derailed restarts?

Nothing. They're separate containers with `restart=unless-stopped`. Derailed restarting, updating,
or even being uninstalled doesn't stop them. On boot it reconciles: it compares what's running
against what it expects and fixes the difference.

### What happens if a deploy fails?

The previous version keeps serving. A new container is only routed once it answers a health check,
so a failed deploy is invisible to your visitors.

### Can I roll back?

Yes. The Deploys tab has a Roll back button on previous successful deploys. It re-runs that
deploy's image with no rebuild, so it's quick.

### Why is my temporary address HTTP and not HTTPS?

Deliberate, and unavoidable: `sslip.io` is not on the public suffix list, so every address under it
worldwide shares one allowance of fifty certificates a week. Point a domain of your own at the
server and every app gets a secured name instead. See [domains](domains.md).

### Can I control it from Claude Code or Cursor?

Yes. Derailed is an MCP server, so a coding agent can deploy apps, read logs, add domains and
check on the machine in the same conversation where you are writing the code.

Create a token in **Settings, under Coding agents**, then add this to your agent:

```json
{
  "mcpServers": {
    "derailed": {
      "command": "derailed",
      "args": ["mcp"],
      "env": {
        "DERAILED_URL": "https://your-dashboard-domain",
        "DERAILED_TOKEN": "drl_..."
      }
    }
  }
}
```

The `derailed` binary needs to be on the machine running the agent, which can be your laptop.
It talks to your server over the same HTTP API the dashboard uses, so an agent can never do
anything you couldn't do yourself. Revoking the token cuts it off immediately.

### How much does it cost?

Nothing. MIT licensed. You pay for the server.

### Is it ready for production?

It is early. It's tested, including against real Docker and a real PostgreSQL, and it has been run
on a real server throughout its development, but it's a young project. Run it for side projects and internal tools first, keep backups, and please report what
breaks.
