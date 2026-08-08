<div align="center">

<img src="assets/logo.svg" alt="" width="88" height="88">

# Derailed

### Your own tiny cloud.

**One binary on your server. Paste a GitHub link, get a running app with HTTPS.**

No YAML. No `docker-compose` to babysit. No Kubernetes. No monthly bill.

[![MIT licence](https://img.shields.io/badge/licence-MIT-5f27c9)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-fbf0df)](https://bun.sh)
[![Self-hosted](https://img.shields.io/badge/self--hosted-your%20server-7236e3)](docs/install.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-5f27c9)](docs/contributing.md)

<br>

<img src="docs/images/topology.png" alt="The Derailed topology view" width="820">

</div>

<br>

## Install it

On a fresh Linux server, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/emilishostinger/derailed/main/install.sh | sh
```

That is the whole setup. It installs Docker if it is missing, drops a single binary at
`/usr/local/bin/derailed`, sets it up as a service, and prints a URL. Open the URL, make
an account, paste a repository link.

<sub>Debian, Ubuntu, Fedora, RHEL, Rocky, Alma, Arch, Alpine, openSUSE · 64-bit Intel or ARM ·
nothing else to install · takes about a minute ·
[other ways to install](docs/install.md) · [what it does to your server](docs/security.md)</sub>

<br>

## The problem

You have a $5 VPS and something you want to put on the internet.

Today that means SSH, Docker, a reverse proxy, certificates, DNS, a systemd unit and a
weekend. Then a month later you cannot remember how any of it fits together, and the
certificate has quietly expired.

Derailed makes it five minutes in a browser, and keeps making sense afterwards.

<br>

## What you get

|  |  |
| --- | --- |
| 🚀 **Paste a link, get an app** | Any GitHub repository, public or private. Dockerfile or not: without one, Derailed works out how to build it and says what it found in plain language. |
| 🔄 **Push, and it deploys** | Turn it on and the running app catches up with your branch on its own, within a couple of minutes. No webhook, no public URL, no shared secret. Works with GitLab, Bitbucket and Gitea too. Or wait for a tagged release instead, if pushing and shipping are separate decisions. |
| 📦 **Or just drag in a zip** | A folder of HTML is served as it is. A folder of PHP gets PHP and Apache. No repository, no account, no build step. |
| ⚡ **Twenty apps in one click** | WordPress, Nextcloud, Gitea, Jellyfin, Vaultwarden, Grafana and more, each with its database and storage already right. |
| 🔒 **HTTPS that just happens** | Type your domain, follow the on-screen checklist, get a padlock. Point a wildcard at the server and every app gets a secured name automatically. |
| 🆓 **A padlock without buying a domain** | Claim a free name in about a minute and every app gets real HTTPS on it, now and in future, from a single wildcard certificate. No tunnel, no third party between you and your visitors. |
| 🗄️ **Databases in one click** | PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Valkey. Private by default. Connect one to an app and the credentials are wired in for you. |
| 📈 **Visitor figures, no tracker** | Counted by the proxy that already serves every request. No script in your pages, nothing leaves the machine, nothing to consent to. |
| 🗑️ **Nothing you press is final** | Deleting stops an app and frees its addresses, but keeps everything it stored for a week. There is an Undo on the way out, and a trash you can fish it back from. |
| 💾 **Backups you can restore** | Scheduled per project, and an ordinary `.tar.gz` you can download and open with `tar`. Restoring stops the app first, because emptying a folder underneath a running app is how people lose data. |
| ☁️ **And backups that leave the building** | Copied to Backblaze, R2, Wasabi, Storj, MinIO or anywhere else that speaks S3, so losing the server does not lose them too. The Test button writes a file, reads it back and deletes it, because keys that can write and not read are the usual nasty surprise. |
| ✅ **Backups that prove they restore** | Once a month Derailed opens the newest one and checks every database dump and stored folder inside it is complete, then says so. Every other tool tells you a backup was made; this is the part anyone actually cares about. |
| 🪃 **Updates that take a backup first** | Updating an app is: back it up, update it, check it still answers. A version that never answers is thrown away while the old one keeps serving, and one press puts the exact previous version back. Per-app automatic updates, if you want them. |
| 🌱 **Databases that grow up safely** | Postgres 16 to 17 is a button: copy first, new engine proves itself on a fresh volume, old engine kept stopped for a week. And for Postgres alone, a real point-in-time restore: wind back to a *moment*, not just to the nearest copy. |
| 🧩 **A `docker-compose` repository just works** | Point Derailed at a repo with a compose file and get a project of linked services: containers on the map, volumes as storage, `depends_on` as start order. Whatever can't be honoured is said plainly at import time, not discovered at deploy time. You never edit the YAML. |
| 🗄️🏠 **Runs on the computer in your cupboard** | An old laptop is a $0/month server. One-click Tailscale makes it reachable to *you* from anywhere, no port forwarding, no DNS knowledge; Tailscale Funnel takes one app the rest of the way to the public internet, real HTTPS included. No relay of ours in the path, ever. |
| 🧪 **Previews with their own copy of the data** | A branch preview can get a real copy of every linked database, loaded from the newest hourly copy, with an optional scrub command for real-shaped data without real people in it. Enterprise platforms charge enterprise money for exactly this; on one box it is a dropdown. |
| 🚪 **One login in front of any app** | Put your accounts, 2FA included, in front of anything: Uptime Kuma, a client's staging site, the household photo app. A real login page on the app's own address, sessions you can see and end, and the app itself is never touched. |
| 🤖🚫 **Block the bots** | One screen: slow down whatever asks too fast (off / polite / strict, with an invisible proof-of-work check a person's browser passes in a second), and one toggle that turns away the named AI scrapers with a `robots.txt` to match. The traffic chart shows bots vs people, so the knob has a number. |
| 📨 **Forms on any site** | Add `data-derailed="contact"` to a form in plain HTML and submissions land in a Messages tab, with an email to you, a spam honeypot and a CSV export. No backend, no third-party service, no logo in the confirmation. |
| 🛬 **Arriving from Heroku, Render, Railway or Fly** | The same import reads `app.json` + `Procfile`, `render.yaml`, `railway.json` or `fly.toml`: processes become services, add-ons become databases of the right engine wired in under the same names, schedules become jobs. Secret *names* are pre-filled; the values were never in the repo, and the plan says exactly where to paste them. [The whole move, in order.](docs/leaving-heroku.md) |
| 💬 **Ask your server** | A chat box in the dashboard: *"why is the blog slow"*, *"restart the api"*, *"what broke overnight"*. Runs on your own AI key or an Ollama on the box, drives the same tools coding agents use, with your own role and audit log, and every change waits behind a confirm button. |
| 🤖 **Runs from your editor** | An MCP server, so Claude Code, Cursor or Codex can deploy, read logs and add domains in the same conversation where you write the code. |
| 🖼️ **Your apps, not a process list** | Every tile carries the site's own icon and title, read from the thing that is actually running. Turn on screenshots and it carries a picture too. |
| 🗺️ **A map, not a wall of panels** | The project view *is* the topology: what is running, what talks to what, what is on fire. |
| 📁 **Files, without SSH** | Browse an app's storage, upload, download, rename, delete, edit a file. Scoped to the folders you attached, which are the only ones worth editing anyway. |
| ✉️ **Your apps can send email** | One toggle hands an app the same mail settings Derailed uses, under every name the common apps look for. The number one "I installed it and it half works" problem in self-hosting. |
| 🔀 **One domain, several apps** | `example.com` your site, `example.com/blog` WordPress, `example.com/api` your backend. Longest path wins, and it is a text field rather than a proxy rule. |
| 🔎 **Look inside your database** | All six engines. Rows you can edit a cell at a time, documents you open as JSON, keys you can search through, and a box for asking questions that only reads, inside a read-only transaction so the engine refuses the rest rather than us guessing at your SQL. Runs the engine's own client inside its own container, so nothing is bundled and no port is opened. |
| 📜 **What your app is printing** | Live output from the running program, per app or for the whole server at once. The first place to look when a site is up and behaving oddly, and previously the one thing you had to open a terminal for. |
| 📉 **Load, with a memory** | Processor and memory kept by the hour for a month, with every deploy drawn on the chart. "Memory started climbing on Tuesday" is an observation; "right after that deploy" is a diagnosis. |
| ⏰ **Things that run on a schedule** | WordPress cron, a nightly cleanup, a weekly report. Two questions: what to run and how often, with the how-often as a list of choices rather than five asterisks. Every run keeps what it printed, and a failure tells you. A job attached to an app runs inside it; one attached to nothing runs on the machine, and that kind is an owner's alone. |
| 🔑 **Password-protect anything, one toggle** | A username, a password, and the site is private. Or an address list, or a block list, or a "back shortly" page. All done by the proxy, so it works for WordPress, a folder of HTML, or anything else, unchanged. |
| ⏪ **A copy of your database from an hour ago** | Taken hourly, kept for two days, put back in one press. Not point-in-time recovery and it says so: it restores the nearest copy at or before the moment you pick, never a later one, because a later one contains the thing you are undoing. |
| 🧯 **A ceiling per project** | Memory and processor, for every app in it including the ones you add next month. The app that takes a box down is the one nobody expected. |
| 📮 **Wire it into whatever you already have** | A signed JSON message to an address of yours on every deploy, crash, backup and certificate. Every occurrence, not a tidied-up one. |
| 🔐 **Security updates, applied** | The operating system's, checked daily, security only, never a whole-system upgrade and never a reboot. It refuses on the two distributions that cannot tell the difference rather than quietly upgrading everything. |
| 🚪 **What is open to the internet** | Every port, and what each one is for in plain language. Derailed does not touch your firewall: managing one from a web page has a single catastrophic mistake available to it. |
| 📦 **Share what you built** | Turn any app into a template file somebody else can install, with the passwords and keys taken out and a placeholder left where the database goes. |
| 🩹 **"Why did this break?"** | Reads the build log and answers in two sentences with something to press: a missing lockfile, no compiler for a native module, a database that was never connected, migrations that never ran, out of memory. Where it can fix it, it offers to. Where it does not know, it says so. |
| 🖱️ **Drag your project in** | The folder, as it sits on your disk. Node, Python, PHP, or a folder of HTML, with no Dockerfile from you. Dependency and build folders are skipped on the way up, so there is nothing to tidy first. |
| 🔗 **Templates from a link** | Paste the address of a template file and get an app. Validated hard on the way in, and every field Derailed does not define is dropped rather than passed through. The address is resolved and checked before anything is opened, and every redirect after it, so the panel cannot be pointed at your own network. |
| 😴 **Apps that sleep** | Pause an app after a stretch of quiet and start it again when somebody visits. On a $5 box that is the difference between running twelve side projects and four. |
| 🌿 **A copy of your app for every branch** | Push a branch and it gets its own running copy at its own address, sharing the real database. Delete the branch and the copy goes with it, which is the part everybody forgets to do by hand. One toggle, no naming patterns, no webhook. |
| 🤝 **Adopt what's already running** | A machine that already has containers on it is not a dead end. Take one over and it keeps running exactly as it is, while gaining an address, a certificate, uptime checks and a place in the map. |
| 📦 **Move to another server** | One file with everything: projects, apps, databases, domains, and a backup of each. Nothing here traps you, and the file opens with `tar` whether or not you ever move. |
| 📱 **Point your phone at it** | A QR code beside every address, so what you just deployed opens on the device it will actually be looked at on. Drawn by the dashboard itself, so no online generator learns your addresses and it works on a server with no internet. |
| 👥 **More than one person** | Owners, members and viewers. A client who can look and not touch, or a collaborator who can deploy but not delete. Enforced in one place rather than route by route, so the route added next Tuesday is covered before it is written, and checked in the handful of places where the difference is in the request rather than the address. |
| 🔐 **Two-step sign-in** | A code from your phone as well as your password, with recovery codes for the day you lose it. Plus a list of every session, and a record of who changed what. |
| 📡 **Is it actually up?** | The request a visitor would make, every five minutes, with ninety days kept. A container can be running while its site serves nothing, which is exactly what a crash alert cannot see. |
| 🌐 **A status page you can share** | One toggle puts a real page at `/status`, readable with no sign-in, and tells you the address to send people. One self-contained file with no scripts and no requests anywhere, because it is what people open when everything else is broken. It never says all is well before it has checked, and gives away nothing about your projects, apps or machine. |
| 🔔 **It tells you when something dies** | Crashes, crash loops, failed deploys, a filling disk, an expiring certificate, a backup that turns out not to restore. To your phone, Discord, Slack, Telegram or email. The same problem is never reported twice, and every message says what to do. |
| 🩺 **One button that checks everything** | Docker, the router, disk, memory, swap, the clock, domains, certificates and backups, each either fine or telling you what to do. `derailed doctor` on the command line, for when the dashboard is the broken thing. |
| 🐷 **What this would cost elsewhere** | Adds up what is actually running and prices it against Vercel, Railway, Render and Heroku, from published list prices, deliberately conservatively. The value of your own server is otherwise invisible. |
| 💬 **Plain language everywhere** | Never "ingress", never "SIGTERM". When something breaks, the error says what to do next. |

<br>

## See it

|  |  |
| --- | --- |
| ![Command palette](docs/images/command-palette.png) | ![Service drawer](docs/images/service.png) |
| `⌘K` finds projects, apps, actions and the handbook | Logs, deploys, variables and domains in one place |
| ![New service](docs/images/new-service.png) | ![New database](docs/images/new-database.png) |
| A ready-made app, a GitHub link, an image or a zip | Databases in one click, private by default |

There is a light theme too:

![Light theme](docs/images/topology-light.png)

<br>

## Why not just use…

**A PaaS?** Because it is your server, your data, and $5 instead of $25 a month once you
have more than one thing running.

**Plain Docker and a reverse proxy?** That is exactly what this is, with the parts that
are tedious to get right (certificates, health-checked deploys, backups that restore,
storage that survives) done once, properly, and explained.

**Coolify or Dokploy?** Both are further along in features. Derailed aims somewhere
else: at someone who has never opened a terminal. One binary with nothing to install
alongside it, every screen in plain English, and the dangerous actions explaining
themselves before you take them rather than after.

<br>

## How it works

```
  systemd ──▶ derailed          one binary: API + dashboard + build pipeline
              ├── SQLite        /var/lib/derailed/derailed.db
              ├── Docker        unix:/var/run/docker.sock
              └── Caddy admin   127.0.0.1:2019

  Docker
   ├── caddy                    ports 80/443, certificates, access log
   ├── your apps                built from your repositories
   └── your databases           private to their project
```

A deploy is: fetch → work out the build → build an image → start a container → wait for
it to answer → point the proxy at it → retire the old one. The new container is only
routed once it responds, so a failed deploy is invisible to visitors and the old
version keeps serving.

Derailed only ever touches what it created. Everything it makes is labelled, and
anything unlabelled is left alone, so a machine already running other containers is
safe.

<br>

## Documentation

[**Start here**](docs/README.md). The pages people reach for most:

[Quick start](docs/quickstart.md) ·
[Installing](docs/install.md) ·
[Deploying](docs/deploying.md) ·
[Domains and HTTPS](docs/domains.md) ·
[Databases](docs/databases.md) ·
[Storage](docs/storage.md) ·
[Backups](docs/backups.md) ·
[Trash](docs/trash.md) ·
[Disk space](docs/disk.md) ·
[Alerts](docs/alerts.md) ·
[Access](docs/access.md) ·
[Scheduled jobs](docs/jobs.md) ·
[Visitor figures](docs/analytics.md) ·
[Coding agents](docs/mcp.md) ·
[API](docs/api.md) ·
[CLI](docs/cli.md) ·
[Architecture](docs/architecture.md) ·
[Security](docs/security.md)

<br>

## Building it yourself

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # dashboard on :5173, API on :8422
bun test           # unit and integration; Docker tests skip themselves without a socket
bun run build      # one binary for this machine
bun run build --target=linux-x64     # or cross-compile for a server
```

The dashboard is React and Vite, embedded into the binary at build time, so there is
nothing to serve separately.

<br>

## Honest status

Pre-release, and young. It has been built and run against a real server throughout, the
test suite covers the parts that have broken before, and it is doing real work today.
It has not yet been through a thousand other people's edge cases.

Run it for side projects and internal tools first, keep backups, and
[tell me what breaks](../../issues). That is the fastest way to make it better.

Not there yet: more than one server.

<br>

## Contributing

Issues and pull requests are welcome, especially bug reports from real servers. The
code is commented with the reasoning behind decisions rather than a description of what
each line does, so start with the module you are changing and read its header comment.
See [contributing](docs/contributing.md).

<br>

## Licence

MIT. See [LICENSE](LICENSE).

---

<div align="center">

**If this saves you a weekend, a ⭐ helps other people find it.**

</div>
