# Security

What is protected, how, and what is not. Read the last section before you decide this
is safe enough for what you are about to put on it.

## Signing in

- Passwords are hashed with argon2id and never stored or logged in any other form.
- Ten characters minimum, everywhere: setting the account up, changing the password,
  and `derailed reset-password` all ask for the same thing.
- Sign-in is rate limited to five attempts a minute, counted against the address the
  connection actually came from. `X-Forwarded-For` is only read when the connection
  came from Caddy itself, so a caller off the internet cannot rename themselves into a
  fresh allowance on every request. There is a second, looser ceiling of thirty a
  minute against the socket itself, which covers the case where the header can be
  believed and the thing writing it is a container that should not be trusted.
  A successful sign-in clears both.
- An unknown email is verified against a decoy hash so response timing does not reveal
  which accounts exist.
- Sessions are random opaque ids in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie.
- Changing the password ends every other session.
- Changing the email or password requires the current password, even though the session
  is already trusted: an unattended screen should not be enough to move an account.
- Lost the password? `derailed reset-password` on the server. That is deliberately the
  only way back in, and it requires the machine.

## Requests

- Cookie-authenticated requests must carry `X-Requested-With: derailed`. A browser will
  not add that header on a cross-site request, so another site cannot act as you.
- API tokens go in `Authorization: Bearer`, are 32 random bytes prefixed `drl_`, and are
  stored only as SHA-256 hashes. A stolen database yields no working tokens.
- Tokens have full access. Treat one like the password, and revoke it in Settings when
  a laptop goes missing.
- Every reply carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin` and a policy of `frame-ancestors 'none';
  base-uri 'none'; form-action 'self'; object-src 'none'`, so the dashboard cannot be
  framed and put under someone else's buttons, cannot have every relative link on it
  repointed, and cannot be made to post anywhere else. API replies are
  `Cache-Control: no-store`.
- A websocket is checked against `Origin` before the cookie is even read. `new
  WebSocket(...)` is exempt from CORS, so the header above does not cover it, and
  `SameSite=Lax` keeps cookies away from other *sites* rather than other origins: an app
  deployed at `app.example.com` is the same site as a dashboard at `panel.example.com`.
  Without the check, a page that app served could have opened `/api/terminal` carrying
  your session and got a shell inside any container here.

## Secrets at rest

Database passwords, repository tokens, the SMTP password for update emails, and
environment variable values are encrypted with AES-256-GCM using
`/var/lib/derailed/secret.key` (mode 600). None of them is ever sent back to the
dashboard: the settings page is told whether a password is stored, never what it is.

Honest threat model: this protects the SQLite file if it is copied off the machine. It
does not protect against someone who is already root on the machine, because they can
read the key too. Nothing that runs on one box can protect against that, and claiming
otherwise would be the lie.

## The network

- Apps publish their port on `127.0.0.1` only. Visitors reach them through Caddy.
- Databases listen only on their project's private Docker network. Publishing one
  externally is possible and deliberate, never a default.
- Caddy's admin API listens on a unix socket in `/var/lib/derailed/caddy-admin`, and on
  nothing else. That API can replace the whole proxy configuration and has no password
  of its own, so where it listens is the only thing protecting it. It used to be a port
  bound to every interface in Caddy's container. Loopback on the *host* was covered, but
  Caddy is attached to every project's network so it can reach the apps it proxies, and
  that put the port in front of every container Derailed runs: an app someone deployed
  could have taken over the routing for every site on the machine, the dashboard's own
  address included. A socket in a root-only folder is reachable from the host and from
  nowhere else.
- Certificates come from Let's Encrypt over HTTP-01 and renew themselves.
- Anything with a certificate redirects HTTP to HTTPS, with the ACME challenge path
  excluded so renewal cannot walk into its own redirect.

## Uploads

A zip is unpacked in-process, with no external tools. Entries that try to write outside
the destination, the `../../etc/cron.d/anything` trick, are refused, and symlinks are
skipped rather than followed.

The size cap counts what actually came out, not what the archive said would come out.
An archive can declare nought bytes and still inflate to gigabytes, so believing the
declared figure meant a 600 KB upload could write 600 MB and take most of a gigabyte of
memory doing it. There is a ceiling per file and a ceiling for the whole archive, and
the upload is refused on its declared length before the body is read at all.

## Visitors

The [figures](analytics.md) are counted from the proxy's own log, which is turned into
counters and discarded. Visitor addresses are hashed with a server-only key and dropped
after 45 days. Query strings and referrer paths are never stored.

## What Derailed touches

Only what it created. Every container, network and volume it makes is labelled
`derailed.managed=true`, and anything unlabelled is left alone. It runs as root because
it manages Docker, which is equivalent to root anyway.

## What this does not protect you from

- **A compromised app.** Containers are isolation, not a sandbox. An app with a remote
  code execution hole is a foothold on your server, the same as anywhere else.
- **Someone with root on the box.** They have everything, including the encryption key.
- **A malicious image.** Running `docker run` on something from the internet is running
  someone else's code as root. Derailed makes that easier, which cuts both ways.
- **Your own backups.** A copy on the same disk as the thing it protects is not a
  backup. Download them.
- **Denial of service.** There is no rate limiting in front of your apps beyond what
  Caddy does by default.

## Updating itself

`derailed update` and the installer both download over HTTPS and check the binary
against the `checksums.txt` published with the release. A missing checksum file, a
release with no entry for this architecture, or a mismatch all stop the update with
nothing changed. This binary runs as root, so "the checksum was missing, so I installed
it anyway" is not something it is able to say.

The same now goes for Nixpacks, the builder fetched for repositories with no Dockerfile.
It also runs as root here, and it is checked against a SHA-256 recorded in Derailed's own
source, because Nixpacks publishes no checksums of its own. There is no longer a fallback
to "whatever the newest release is" when the pinned download fails: that fallback meant a
pinned version was only pinned while the pinned file kept resolving, and the moment it did
not, the server ran an unreviewed build. Moving to a new one is a change to that table and
a release of Derailed.

## Reporting something

Use GitHub's private vulnerability reporting on the repository, or contact the
maintainer directly. Please do not open a public issue for an unpatched vulnerability.
See [SECURITY.md](../SECURITY.md).
