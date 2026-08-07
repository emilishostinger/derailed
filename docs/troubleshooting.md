# When something goes wrong

Derailed tries to say what's wrong and what to do about it, in the dashboard, in plain language.

## Reading what an app is printing

**Your app → Logs.**

What the program itself is writing, as it writes it. This is the first place to look
when a site is up but behaving oddly: the container is running, so nothing is
"crashed", and the answer is usually in the last twenty lines it printed.

The last five hundred lines are kept while the app runs, and new ones appear as they
happen. They survive a redeploy in the sense that the tab keeps working: it notices the
new container and follows that instead.

Build output is a different thing and lives under **Deploys**, with the deploy it
belongs to.

Every app at once is on **Server → Logs**, for when something on the machine is
complaining and you do not yet know which app it is.

On the command line: `derailed logs <app>`.


## Start here

```sh
derailed doctor
```

Checks Docker, the router, disk, memory, swap, the clock, your domains, certificates and backups,
and says what to do about anything it finds. It exits non-zero when something needs attention, so
it works in a cron job or a monitoring check too.

The same list is on the **Server** page in the dashboard, where anything Derailed can put right has
a button next to it. Use the command when it is the dashboard itself that is not working.
This page is for the cases where that isn't enough.

The first thing to try, always:

```sh
journalctl -u derailed -n 100 --no-pager
```

## The dashboard won't load

**Check it's running.**

```sh
systemctl status derailed
```

**Check it's listening.**

```sh
curl -H 'x-requested-with: derailed' http://localhost:8422/api/health
```

If that works but you can't reach it from your laptop, it's a firewall. See
[install.md](install.md#firewall), or tunnel in:

```sh
ssh -L 8422:localhost:8422 root@your-server
```

## "Derailed can't reach Docker"

The dashboard still loads when Docker is broken, deliberately, because that's exactly when you
need to read the error.

```sh
systemctl status docker
systemctl start docker
docker info
```

If Docker is running but Derailed still can't see it, check the socket exists at
`/var/run/docker.sock`. If it's somewhere else, point Derailed at it in
`/etc/systemd/system/derailed.service`:

```ini
Environment=DOCKER_SOCKET=/run/docker.sock
```

then `systemctl daemon-reload && systemctl restart derailed`.

## A deploy failed

Press **Why did this break?** on the failure. Derailed reads what the build actually
printed and, for about two dozen failures it recognises, answers in two sentences with
something to press: a missing lockfile, a native module with no compiler, a database
that is not connected, migrations that never ran, a full disk, a build that ran out of
memory.

Where it can put the problem right itself, it offers to: adding swap and freeing disk
space are both one button from the failure card.

When it does not recognise something it says so, rather than guessing. A confident
wrong answer would send you off for an hour on whatever it happened to name.


Open the **Deploys** tab on the service. Every deploy keeps its full build log, and a failed one
shows a summary at the top. The common ones:

**"That repository doesn't exist, or it's private."**
Derailed can only deploy public repositories for now. Check the link, and that the branch exists.

**"The app started but never answered on port 3000."**
Derailed guessed the wrong port. Set it in **Settings** on the service, then redeploy. Most
frameworks honour the `PORT` environment variable, which Derailed always sets, if yours reads a
different variable, add it in **Variables**.

**"There's nothing to deploy in that repository."**
No Dockerfile, and Nixpacks couldn't work out how to build it. If the app lives in a sub-folder,
set the folder in Settings. Otherwise add a Dockerfile.

**The build ran out of memory.**
Small VPSes struggle with large builds. Add swap:

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**"This server has only … of disk space left."**
Derailed prunes old build logs and images automatically, but Docker keeps more:

```sh
docker system prune -a
```

## A domain won't go green

The **Web address** tab shows exactly which step is stuck.

**"This domain doesn't point anywhere yet"** or **"points somewhere else"**. The A record isn't
right yet. Derailed re-checks every 30 seconds; DNS changes can take anywhere from a minute to a
few hours. Verify what the world sees:

```sh
dig +short your-domain.com
```

That must match the public address shown in Settings. If your server is behind NAT and the
detected address is wrong, override it there.

**DNS is right but there's still no padlock.** Certificates come from Let's Encrypt over port 80 -
if 80 is closed or something else is bound to it, issuance fails silently from your side.

```sh
docker logs derailed-caddy --tail 50
```

**Cloudflare users:** set the record to "DNS only" (grey cloud) until the certificate is issued.
Proxied records prevent the challenge from reaching your server.

## The temporary address isn't HTTPS

That's deliberate. Every generated `*.sslip.io` address is served over plain HTTP, because asking
Let's Encrypt for a certificate per throwaway hostname burns through rate limits quickly and would
eventually break certificate issuance for everyone on the box.

You don't have to buy a domain to fix this. **Settings → A secure address, free** gets you a free
DuckDNS name and a real certificate covering every app in about a minute. See
[domains](domains.md#without-a-domain-but-with-a-padlock).

## Every app times out, and the router looks fine

A proxy that is running, has its ports mapped and answers nothing is nearly always one of two
things.

**Something else owns the port.** Another web server on the machine, usually Apache or nginx,
already listening on 80. Derailed says so by name when it happens. Stop the other one:

```sh
systemctl stop apache2   # or nginx
```

**The router resumed an old configuration.** Caddy saves its own configuration and reloads it on
start, and that saved copy names the address its control API listens on. A container rebuilt with a
different address would resume the old one, come up, and be unreachable for the rest of its life.
Derailed now discards that saved copy whenever it builds a new container, so this should not
happen; if you are on an older version and see it, remove the container and let Derailed rebuild:

```sh
docker rm -f derailed-caddy
docker volume rm derailed-caddy-data-config
systemctl restart derailed
```

Your certificates live in a different volume and are not affected.

To check what the router is actually serving:

```sh
curl --unix-socket /var/lib/derailed/caddy-admin/admin.sock http://x/config/ | head -c 400
```

## "all predefined address pools have been fully subnetted"

Docker hands each project its own network, and it can only allocate about thirty of
them before it runs out. When it does, nothing can create a network again: no new
project, no new database, no deploy, on a machine that otherwise looks completely
healthy.

Derailed removes project networks belonging to projects that no longer exist at every
boot, so this should not build up. If you are on an older version, or something else
on the machine is using them:

```sh
docker network prune          # removes every unused network, not only Derailed's
docker network ls | wc -l     # should be comfortably under thirty
```

Networks belonging to something in the trash are deliberately kept, so restoring a
project finds its apps still able to reach their databases.

## I'm locked out of the dashboard

From the server:

```sh
derailed reset-password
```

That sets a new password and signs out every other session. Having root on the box is the proof
of ownership.

## An app keeps restarting

Its container is crashing on start. The **Overview** tab shows the runtime log. That's the app's
own output, which will usually say why. Common causes: a missing environment variable, or a
database connection that isn't configured. If you connected a database after the last deploy,
redeploy so the app picks up the new variables.

## Starting over on one service

Deleting a service from its **Settings → Danger zone** removes its containers and, for a database,
its volume and all its data. It asks you to type the name first.

## Nothing here helped

Open an issue with:

- `derailed version`
- `journalctl -u derailed -n 100 --no-pager`
- the failed deploy's log, if that's the problem
- your OS and architecture (`uname -a`)

## Something on this server is complaining and I do not know which

**Output** in the sidebar is every app's output in one place, live, with the app's name
on each line. Filter to one app with the buttons along the top, or search across all of
them.

This is the page for "something is wrong and I do not yet know where". The per-app Logs
tab answers "how is this app doing", which is a different question and the wrong one
when you do not know which app to open.

Apps with the same name are labelled with their project and slug, so two called
`index.html` are still two different buttons.

### What gets cleaned up, and when

Nothing here grows without a bound, and all of it is swept every six hours:

| | Kept |
| --- | --- |
| Build logs and images | The last 10 deploys per app |
| Visitor figures | 90 days |
| Live visitor rows | One hour |
| Processor and memory history | 30 days |
| Scheduled job runs | The last few per job |
| Database copies | 48 per database |
| The audit log | 90 days |
| Container output | 10 MB per app, three files |

Two of those used to be swept only when Derailed started, which is fine for a machine
that is restarted often and useless for one that is not. A server that stays up for
three months now tidies up 360 times rather than once.
