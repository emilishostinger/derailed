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

Everything below is in the box: one binary, no add-ons, no separate services to run. It
is grouped the way you meet it, from "put my thing online" to "keep it alive for years."

### Put something online

The whole product in one sentence: whatever your project is, get it running with HTTPS
in a few minutes, no Dockerfile required.

|  |  |
| --- | --- |
| 🚀 **Paste a link, get an app** | Any GitHub repository, public or private. Dockerfile or not: without one, Derailed works out how to build it and says what it found in plain language. GitLab, Bitbucket and Gitea too. |
| 🖱️ **Drag your folder in** | The folder as it sits on your disk, or a zip of it: Node, Python, PHP, or plain HTML, no Dockerfile from you. `node_modules` and build folders are skipped on the way up, so there is nothing to tidy first. |
| ⚡ **Twenty apps in one click** | WordPress, Nextcloud, Gitea, Jellyfin, Vaultwarden, Grafana and more, each with its database and storage already right. |
| 🧩 **A `docker-compose` repo just works** | Point Derailed at a repo with a compose file and get a project of linked services: containers on the map, volumes as storage, `depends_on` as start order. Whatever cannot be honoured is said plainly at import time. You never edit the YAML. |
| 🛬 **Arriving from Heroku, Render, Railway or Fly** | Reads `app.json` + `Procfile`, `render.yaml`, `railway.json` or `fly.toml`: processes become services, add-ons become databases wired in under the same names, schedules become jobs. [The whole move, in order.](docs/leaving-heroku.md) |
| 🔄 **Push, and it deploys** | Turn it on and the app catches up with your branch on its own, within a couple of minutes. No webhook, no public URL, no shared secret. Or ship on a tagged release instead. |

### Addresses, domains and HTTPS

The part everyone dreads, made a checklist you cannot get wrong.

|  |  |
| --- | --- |
| 🪄 **DNS records written for you** | Connect Cloudflare once, pick the domain from a dropdown, and the A record, www CNAME and wildcard write themselves, DNS-only so certificates keep arriving. The biggest onboarding cliff, removed. |
| 🔒 **HTTPS that just happens** | Type your domain, follow the on-screen checklist, get a padlock. Point a wildcard at the server and every app gets a secured name automatically. |
| 🆓 **A padlock without buying a domain** | Claim a free name in about a minute and every app gets real HTTPS on it from a single wildcard certificate. No tunnel, no third party between you and your visitors. |
| 🔀 **One domain, several apps** | `example.com` your site, `example.com/blog` WordPress, `example.com/api` your backend. Longest path wins, and it is a text field rather than a proxy rule. |
| 📱 **Point your phone at it** | A QR code beside every address, drawn by the dashboard itself, so no online generator learns your addresses and it works on a server with no internet. |

### Databases

Private by default, and looked after for their whole life.

|  |  |
| --- | --- |
| 🗄️ **Databases in one click** | PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Valkey. Connect one to an app and the credentials are wired in for you. |
| 🔎 **Look inside your database** | All six engines: rows you edit a cell at a time, documents as JSON, keys you can search, and a query box that only reads, inside a read-only transaction so the engine refuses the rest. Runs the engine's own client in its own container, nothing bundled, no port opened. |
| 🌱 **Databases that grow up safely** | Postgres 16 to 17 is a button: copy first, new engine proves itself on a fresh volume, old engine kept stopped for a week. And Postgres alone gets a real point-in-time restore: wind back to a *moment*, not just the nearest copy. |
| ⏪ **A copy from an hour ago** | Taken hourly, kept for two days, put back in one press: the nearest copy at or before the moment you pick, never a later one. |

### It looks after itself

The trust that makes a server yours to forget about: nothing you do here can quietly
lose your data.

|  |  |
| --- | --- |
| 💾 **Backups you can restore** | Scheduled per project, an ordinary `.tar.gz` you can download and open with `tar`. Restoring stops the app first, because emptying a folder under a running app is how people lose data. |
| ☁️ **Backups that leave the building** | Copied to Backblaze, R2, Wasabi, Storj, MinIO or anywhere that speaks S3. The Test button writes a file, reads it back and deletes it, because keys that can write and not read are the usual nasty surprise. |
| ✅ **Backups that prove they restore** | Once a month Derailed opens the newest one and checks every dump and stored folder inside is complete, then says so. Every other tool tells you a backup was *made*; this is the part anyone actually cares about. |
| 🪃 **Updates that take a backup first** | Back it up, update it, check it still answers. A version that never answers is thrown away while the old one keeps serving, and one press puts the exact previous version back. Automatic per app, if you want it. |
| 📋 **What will change** | Flip one switch and edits to variables, settings and domains collect into "3 changes waiting, apply together?" with a diff a person can read, values never included. And every variable save lands in a history of which keys moved and when. |
| 🕵️ **Is anything leaking or known-broken?** | A daily scan with plain verdicts: live-key-shaped strings in your repos and variables, the password nobody changed, and (with Trivy) known holes in the images behind your apps, wired straight to the update button. |
| 🩺 **Health checks that speak the app's language** | One dropdown for what "healthy" means: answers on its port, its answer contains a text, its port accepts a connection, a command inside it succeeds, or it just keeps running. The contains check catches an app serving its error page with a straight face and a 200. |
| 🗝️ **SSH keys, and the toggle that matters** | See every key that can open the machine, add one by paste, and turn off password login as one honest switch. It refuses to lock the door while no key could still get you in, and proves the config parses before reloading. |
| 🔐 **Security updates, applied** | The operating system's, checked daily, security only, never a whole-system upgrade and never a reboot. |
| 🚪 **What is open to the internet** | Every port and what each is for in plain language. Derailed does not touch your firewall: managing one from a web page has a single catastrophic mistake available to it. |
| 🗑️ **Nothing you press is final** | Deleting stops an app and frees its addresses but keeps everything it stored for a week, with an Undo on the way out and a trash to fish it back from. |
| 🧯 **A ceiling per project** | Memory and processor, for every app in it including the ones you add next month. The app that takes a box down is the one nobody expected. |

### See what is happening

Every screen answers a question you actually have, in words, not a wall of panels.

|  |  |
| --- | --- |
| 🗺️ **A map, not a wall of panels** | The project view *is* the topology: what is running, what talks to what, what is on fire. Every tile carries the running site's own icon and title, and a screenshot if you switch it on. |
| 📜 **What your app is printing** | Live output from the running program, per app or the whole server at once. The first place to look when a site is up and behaving oddly. |
| 📉 **Load, with a memory** | Processor and memory kept by the hour for a month, every deploy drawn on the chart. "Memory started climbing on Tuesday" is an observation; "right after that deploy" is a diagnosis. |
| 📈 **Visitor figures, no tracker** | Counted by the proxy, no script in your pages, nothing leaves the machine. Plus the pages people looked for and did not find: "312 people tried /blog/rss this month" is a broken link with an address, not a mood. |
| 📡 **Is it actually up?** | The request a visitor would make, every five minutes, ninety days kept. A container can run while its site serves nothing, which is exactly what a crash alert cannot see. |
| 🌐 **A status page you can share** | One toggle puts a real page at `/status`, readable with no sign-in. One self-contained file with no scripts and no outside requests, because it is what people open when everything else is broken. It gives away nothing about your machine. |
| 🔔 **It tells you when something dies** | Crashes, crash loops, failed deploys, a filling disk, an expiring certificate, a backup that turns out not to restore. To your phone, Discord, Slack or Telegram. The same problem is never reported twice, and every message says what to do. |
| 🩺 **One button that checks everything** | Docker, the router, disk, memory, swap, the clock, domains, certificates and backups, each either fine or telling you what to do. `derailed doctor` on the command line, for when the dashboard is the broken thing. |
| 🩹 **"Why did this break?"** | Reads the build log and answers in two sentences with something to press: a missing lockfile, no compiler for a native module, a database that was never connected, out of memory. Where it can fix it, it offers to. |
| 🐷 **What this would cost elsewhere** | Adds up what is actually running and prices it against Vercel, Railway, Render and Heroku, from published list prices, deliberately conservatively. |

### The folder-of-HTML kit

Everything the person who has a folder of files, not a build pipeline, needs, and cannot
get anywhere else without renting it.

|  |  |
| --- | --- |
| ✏️ **Edit a file, and it's live** | Dragged-in sites get a real editor: every uploaded file, syntax highlighting per language, and a save that publishes through the ordinary deploy. One button adds a custom 404 or 500 page, wired up just by existing at the site's root. |
| 🖼️✂️ **Pictures the right size** | Ask for `/_img/photo.jpg?w=800` and it comes back that wide, re-encoded, WebP for browsers that take it. One switch, one sidecar with no published ports, cached in the visitor's browser, and nobody learns what WebP is. |
| 📨 **Forms on any site** | Add `data-derailed="contact"` to a form in plain HTML and submissions land in a Messages tab, with an email to you, a spam honeypot and a CSV export. No backend, no third-party service, no logo in the confirmation. |
| ✉️ **Your apps can send email** | One toggle hands an app the same mail settings Derailed uses, under every name the common apps look for. The number one "I installed it and it half works" problem in self-hosting. |
| 🎩 **WordPress superpowers** | The most-run app on earth given house treatment: one-press passwordless wp-admin, plugin and theme updates behind the backup-first promise, and a staging copy with its own database whose push-to-live backs the whole project up before it writes a byte. |
| 📁 **Files, without SSH** | Browse an app's storage, upload, download, rename, delete, edit. Scoped to the folders you attached, the only ones worth editing anyway. |
| ⏰ **Things that run on a schedule** | WordPress cron, a nightly cleanup, a weekly report. What to run and how often, the how-often a list of choices rather than five asterisks. Every run keeps what it printed. |

### Sharing, safety and people

The controls for when it is not just you, and not just your eyes on it.

|  |  |
| --- | --- |
| 🔑 **Password-protect anything** | A username and password, or an address list, or a block list, or a "back shortly" page, all done by the proxy so it works for WordPress, a folder of HTML or anything else unchanged. |
| 🚪 **One login in front of any app** | Put your accounts, 2FA included, in front of anything: Uptime Kuma, a client's staging site, the household photo app. A real login page on the app's own address, sessions you can see and end, the app never touched. |
| 🤖🚫 **Block the bots** | Slow down whatever asks too fast (off / polite / strict, with an invisible proof-of-work a browser passes in a second), and one toggle that turns away the named AI scrapers with a matching `robots.txt`. The chart shows bots vs people, so the knob has a number. |
| 👥 **More than one person** | Owners, members and viewers: a client who can look and not touch, a collaborator who can deploy but not delete. Enforced in one place, so the route added next Tuesday is covered before it is written. |
| 🔐 **Two-step sign-in** | A code from your phone as well as your password, recovery codes for the day you lose it, a list of every session, and a record of who changed what. |
| 🌿 **A copy of your app for every branch** | Push a branch and it gets its own running copy at its own address; delete the branch and the copy goes with it. Optionally with a real copy of the data, scrubbed, so "test on a copy" means a copy. |
| 📦 **Share what you built** | Turn any app into a template file somebody else can install, with the passwords and keys taken out and a placeholder where the database goes. |
| 📮 **Wire it into whatever you have** | A signed JSON message to an address of yours on every deploy, crash, backup and certificate. Every occurrence, not a tidied-up one. |

### From your laptop, and anywhere

The loop from your machine to the server and back, and the freedom to run it on any box.

|  |  |
| --- | --- |
| 🤖 **Runs from your editor** | An MCP server, so Claude Code, Cursor or Codex can deploy, read logs, edit a file, run the security scan, drive WordPress and more, in the same conversation where you write the code. Your role, your audit log, the same confirmations as a person. |
| 💻🌐 **Your laptop, on your domain** | `derailed dev` serves the folder you are in through the server's address on a temporary subdomain, real HTTPS, so a client sees the work-in-progress without a deploy. Close the terminal and it is gone. |
| 🕳️ **A tunnel to your database** | `derailed tunnel blog-db` and TablePlus connects to `127.0.0.1`. No port opened to the internet: the server dials the database over the network it already shares with it. The opposite of the expose button. |
| 🗄️🏠 **Runs on the computer in your cupboard** | An old laptop is a $0/month server. One-click Tailscale makes it reachable to *you* from anywhere, and Funnel takes one app to the public internet with real HTTPS. No relay of ours in the path, ever. |
| 🤝 **Adopt what's already running** | A machine with containers already on it is not a dead end. Take one over and it keeps running exactly as it is, gaining an address, a certificate, uptime checks and a place in the map. |
| 😴 **Apps that sleep** | Pause an app after a stretch of quiet, wake it on the next visit. On a $5 box that is the difference between running twelve side projects and four. |
| 📦 **Move to another server** | One file with everything: projects, apps, databases, domains, and a backup of each. Nothing here traps you, and the file opens with `tar` whether or not you ever move. |
| 🧹 **Leaves no trace** | `derailed uninstall` puts the machine back the way the installer found it: apps, data, service and the binary itself, gone after one typed confirmation. Docker stays. |
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
bun run dev        # dashboard on :1337, API on :31337
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
