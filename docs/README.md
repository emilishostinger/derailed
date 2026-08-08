# Derailed documentation

Derailed is one binary on your own server that turns a GitHub link, a zip of files, or a
Docker image into a running website with HTTPS. This is the full reference. If you only
want something on the internet, start with the [quick start](quickstart.md); it takes
about five minutes.

## Using it

- **[Quick start](quickstart.md)**: from a bare server to a live site
- **[Installing](install.md)**: requirements, what the installer does, updating
- **[Deploying](deploying.md)**: repositories, zips, images, compose files, redeploys and rollback
- **[Leaving Heroku](leaving-heroku.md)**: the whole move, in order, from there or Render, Railway and Fly
- **[Ready-made apps](apps.md)**: the catalogue, and which ones have been run
- **[Domains and HTTPS](domains.md)**: your domains, automatic addresses, certificates
- **[Databases](databases.md)**: engines, credentials, connecting an app
- **[Storage](storage.md)**: what survives a redeploy, and what does not
- **[Backups](backups.md)**: schedules, retention, restoring, taking a copy away
- **[Files and app email](files.md)**: browsing an app's storage, and letting it send mail
- **[Forms](forms.md)**: working forms on a plain site, one attribute, no backend
- **[Pictures the right size](images.md)**: `/_img/photo.jpg?w=800`, resized and re-encoded on the fly
- **[A copy per branch](previews.md)**: every branch gets its own running app, and loses it
- **[Scheduled jobs](jobs.md)**: cron, in plain words, with the output kept
- **[Who can see your apps](access.md)**: passwords, address lists and maintenance mode
- **[What will change](review.md)**: edits that collect, show a readable diff, and apply together
- **[Uptime](uptime.md)**: is it actually up, ninety days of history, and a public status page
- **[Alerts](alerts.md)**: being told when something breaks, without it becoming noise
- **[Disk space](disk.md)**: what is using it, freeing it up safely, and swap
- **[The computer in your cupboard](cupboard.md)**: an old laptop as a $0/month server, reachable from anywhere
- **[Moving servers](moving.md)**: taking everything with you, and what deliberately stays
- **[Trash](trash.md)**: deleting is undoable for a week, and what that does and does not cover
- **[Visitor figures](analytics.md)**: how visits are counted, and what is never kept
- **[Coding agents (MCP)](mcp.md)**: driving Derailed from Claude Code, Cursor or Codex
- **[More than one person](people.md)**: owners, members and viewers, and where the line is
- **[The API](api.md)**: tokens and every endpoint
- **[The command line](cli.md)**: every command and environment variable
- **[Questions people ask](faq.md)**
- **[When something breaks](troubleshooting.md)**: the usual causes, in order

## Understanding it

- **[Architecture](architecture.md)**: what runs where, and why it is built this way
- **[Security](security.md)**: the honest threat model, including what this does not protect
- **[Contributing](contributing.md)**: running it locally, tests, and the conventions
- **[Release checklist](release-checklist.md)**: what a machine cannot check for us

## The short version

Derailed runs on the host as a service (systemd, or OpenRC on Alpine). Everything else, meaning your apps, your databases and
the Caddy reverse proxy that fronts them, runs in Docker containers it creates and
labels. It touches nothing it did not create.

A deploy is: fetch the code, work out how to build it, build an image, start a
container, wait for it to answer, point Caddy at the new one, retire the old one. The
new container is only routed once it responds, so a failed deploy is invisible to
visitors and the previous version keeps serving.

State lives in `/var/lib/derailed`: a SQLite database, an encryption key, build logs,
backups, and the proxy's access log. Back that folder up and you have backed up
Derailed itself; your apps' own data is in Docker volumes, which is what
[backups](backups.md) copy.
