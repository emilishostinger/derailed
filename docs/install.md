# Installing Derailed

## The short version

On a fresh Linux server, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/emilishostinger/derailed/main/install.sh | sh
```

Then open the URL it prints and create your account.

> **Before the first release.** The installer downloads a published binary, so until a
> version is tagged there is nothing for it to fetch. Build one yourself in the
> meantime (see [contributing](contributing.md)) and install it with
> `sudo sh install.sh --binary ./derailed-linux-x64`.


## What the installer actually does

Nothing surprising, and you can read it before running it. It's
[`install.sh`](../install.sh) in this repository.

1. Checks you're on Linux, on 64-bit Intel or ARM, and running as root.
2. Installs `curl`, `git` and `tar` if any are missing.
3. Installs Docker from `get.docker.com` if it isn't already there (it asks first).
4. Downloads the binary for your architecture, verifies it against the published SHA-256 checksum,
   and installs it to `/usr/local/bin/derailed`.
5. Creates `/var/lib/derailed` (mode 700) for the database, secrets and build logs.
6. Writes `/etc/systemd/system/derailed.service`, enables it, and starts it.
7. Waits until the dashboard answers before telling you it worked.

### Options

| Flag | Environment variable | What it does |
| --- | --- | --- |
| `-y`, `--yes` | `DERAILED_YES=1` | Never prompt |
| `--version X.Y.Z` | `DERAILED_VERSION` | Install a specific release |
| `--binary /path` | `DERAILED_BINARY` | Install a local binary instead of downloading |
| `--no-start` | | Install but don't start the service |
| `--domain X` | `DERAILED_DOMAIN` | Serve the dashboard at this domain, over HTTPS |
| `--email X` | `DERAILED_EMAIL` | Create the admin account during install |
| `--password X` | `DERAILED_PASSWORD` | Its password |
| `--no-setup` | `DERAILED_NO_SETUP=1` | Don't ask anything; finish in the browser |
| | `DERAILED_PORT` | Dashboard port (default `8422`) |

### The guided questions

Run interactively, the installer asks for a domain for the dashboard, your email and a
password. Answer them and you're handed `https://your-domain` with a certificate already being
issued and an account you can sign straight into. No plain-HTTP page over an IP address
asking you to invent a password.

Press enter to skip any of them and finish in the browser instead. If the domain doesn't
resolve to this server yet, the installer says so and carries on without it rather than
leaving you locked out.

## Requirements

- **Any Linux with a 64-bit Intel (`x86_64`) or ARM (`aarch64`) processor.**

  Derailed is one static binary and does not care what is underneath it. The installer
  knows `apt`, `dnf`, `yum`, `pacman`, `apk` and `zypper` for the two or three tools it
  needs, and sets Derailed up under systemd or OpenRC, whichever the machine uses. That
  covers Debian, Ubuntu, Fedora, RHEL, Rocky, Alma, Arch, Alpine and openSUSE without
  anything special being done for each.

  A distribution using none of those still works: install `curl`, `git` and `tar`
  yourself and the installer carries on. There is nothing to start it at boot in that
  case, and it says so rather than pretending otherwise.

  Alpine and other musl systems get their own build, chosen for you. A glibc binary
  there does not fail with a message about glibc, it fails with "not found" about a file
  that is plainly present, so it is worth not doing.

- **Docker 25 or newer.** The installer fetches a current one. If the machine already
  has an older Docker from its distribution, the installer says so before changing
  anything: Derailed speaks Docker's API directly and pins a version of it.
- **2 GB of RAM** is comfortable. 1 GB works but building larger apps may run out of memory;
  add swap if you hit that.
- **10 GB of disk** or more. Images add up. Derailed prunes old build logs and images
  automatically and warns you when free space drops below 2 GB.

## Firewall

Derailed needs three ports reachable:

| Port | Why |
| --- | --- |
| `80` | Visitors, and the HTTP-01 challenge that issues your certificates |
| `443` | Visitors, over HTTPS |
| `8422` | The dashboard |

With `ufw`:

```sh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8422/tcp
ufw allow 22/tcp     # don't lock yourself out
ufw enable
```

Better still: give the dashboard its own domain in **Settings → Dashboard address**, so it is
served over HTTPS through Caddy, and then close `8422` entirely. Until you do, the panel is plain
HTTP and your password is sent unencrypted.

If you'd rather not expose the dashboard at all, leave `8422` closed and reach it over an SSH
tunnel:

```sh
ssh -L 8422:localhost:8422 root@your-server
```

Then open `http://localhost:8422`.

## Where things live

| Path | What |
| --- | --- |
| `/usr/local/bin/derailed` | The binary |
| `/var/lib/derailed/derailed.db` | SQLite: projects, services, deploys, domains |
| `/var/lib/derailed/secret.key` | Encrypts stored secrets. **Back this up with the database** |
| `/var/lib/derailed/logs/` | Build and deploy logs (ndjson, pruned automatically) |
| `/var/lib/derailed/builds/` | Scratch space during a build, deleted afterwards |
| `/etc/systemd/system/derailed.service` | The unit file |

### Backing up

The database and the key travel together. The database is useless without the key, because
secrets are encrypted at rest.

```sh
systemctl stop derailed
tar czf derailed-backup.tar.gz -C /var/lib derailed
systemctl start derailed
```

Your apps' data lives in Docker volumes, which this does **not** include. For databases, take a
proper dump with the engine's own tooling.

## Running it

```sh
systemctl status derailed      # is it up?
journalctl -u derailed -f      # what is it doing?
systemctl restart derailed
```

## Updating

```sh
derailed update
systemctl restart derailed
```

The update downloads the new binary, verifies its checksum, and swaps it in atomically. So a
failed download can never leave you with a broken install. Your apps keep running throughout;
they're separate containers. Database migrations run automatically at the next start.

## Uninstalling

```sh
systemctl disable --now derailed
rm /etc/systemd/system/derailed.service /usr/local/bin/derailed
systemctl daemon-reload

# Everything Derailed created is labelled, so this removes only its containers:
docker ps -aq --filter label=derailed.managed=true | xargs -r docker rm -f
docker volume ls -q --filter label=derailed.managed=true | xargs -r docker volume rm
docker network ls -q --filter label=derailed.managed=true | xargs -r docker network rm

rm -rf /var/lib/derailed   # this deletes your database and your secret key
```

## Installing without the script

Grab a binary from [Releases](https://github.com/emilishostinger/derailed/releases):

```sh
curl -fsSLO https://github.com/emilishostinger/derailed/releases/latest/download/derailed-linux-x64
curl -fsSLO https://github.com/emilishostinger/derailed/releases/latest/download/checksums.txt
sha256sum -c --ignore-missing checksums.txt

install -m 0755 derailed-linux-x64 /usr/local/bin/derailed
mkdir -p /var/lib/derailed && chmod 700 /var/lib/derailed
derailed serve
```

## Uninstalling

```sh
derailed uninstall
```

One typed confirmation, then everything Derailed made goes: the apps and databases it runs,
their data, the service, `/var/lib/derailed`, and the binary. Docker itself is left in place.
There is no undo, so if anything on the server still matters, take a backup to another machine
first.
