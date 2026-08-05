# Security

What is protected, how, and what is not. Read the last section before you decide this
is safe enough for what you are about to put on it.

## Signing in

- Passwords are hashed with argon2id and never stored or logged in any other form.
- Sign-in is rate limited to five attempts a minute per address. An unknown email is
  verified against a decoy hash so response timing does not reveal which accounts
  exist.
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

## Secrets at rest

Database passwords, repository tokens and environment variable values are encrypted
with AES-256-GCM using `/var/lib/derailed/secret.key` (mode 600).

Honest threat model: this protects the SQLite file if it is copied off the machine. It
does not protect against someone who is already root on the machine, because they can
read the key too. Nothing that runs on one box can protect against that, and claiming
otherwise would be the lie.

## The network

- Apps publish their port on `127.0.0.1` only. Visitors reach them through Caddy.
- Databases listen only on their project's private Docker network. Publishing one
  externally is possible and deliberate, never a default.
- Caddy's admin API is bound to loopback; only Derailed talks to it.
- Certificates come from Let's Encrypt over HTTP-01 and renew themselves.
- Anything with a certificate redirects HTTP to HTTPS, with the ACME challenge path
  excluded so renewal cannot walk into its own redirect.

## Uploads

A zip is unpacked in-process, with no external tools. Entries that try to write outside
the destination — the `../../etc/cron.d/anything` trick — are refused, symlinks are
skipped rather than followed, and the total unpacked size is capped.

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

## Reporting something

The project is pre-release and has no security contact yet. Until it does, open an
issue for anything already public, and for anything that is not, contact the maintainer
directly rather than filing it publicly.
