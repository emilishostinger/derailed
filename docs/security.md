# Security

What is protected, how, and what is not. Read the last section before you decide this
is safe enough for what you are about to put on it.

## Signing in

- Passwords are hashed with argon2id and never stored or logged in any other form.
- Ten characters minimum, everywhere: setting the account up, changing the password,
  and `derailed reset-password` all ask for the same thing.
- Sign-in is rate limited to five attempts a minute, counted against the address the
  connection actually came from. `X-Forwarded-For` is only read when the connection came
  from Caddy itself, and then it is the address Caddy *added*, the last hop rather than
  the first: Caddy appends the real caller to whatever the caller sent, so the value on
  the left is theirs to invent and rotate and the one on the right is the one our own
  proxy vouched for. Reading the leftmost handed every guess a fresh allowance, which is
  the whole thing this is meant to stop. There is a second, looser ceiling of thirty a
  minute against the socket itself, which covers the case where the header can be believed
  and the thing writing it is a container that should not be trusted. A successful sign-in
  clears both.
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

## Is anything leaking or known-broken?

Once a day, and behind a **Check now** button on the Server page, Derailed runs two
quiet scans and reports in plain verdicts:

- **Things shaped like live keys, where they should never be.** The tip of each app's
  repository (and any uploaded files) is checked for AWS keys, GitHub and GitLab
  tokens, Slack and Stripe and cloud API keys, private key blocks, and database
  addresses with the password written in. A value that is both an environment
  variable and a string in the files is called out separately, because that secret is
  leading a double life. And a variable named like a secret whose value is still
  `changeme` is called what it is: the password nobody changed.

  Lines that say `example` or `placeholder` are left alone. A scanner that flags
  every documentation snippet trains people to dismiss it, and a dismissed scanner
  is no scanner.

  The report never contains the secret itself, only where it sits and a masked
  prefix. Even so, a map to the secrets is not for viewers, and running a fresh scan
  is an owner's button, because it clones repositories to look inside.

- **Known holes in the images behind the apps.** When [Trivy](https://trivy.dev) is
  installed, each deployed image is checked for known vulnerabilities rated high or
  critical, and the verdict is wired to the update button that already exists: *"the
  image behind blog has a known hole, a newer image is published, updating is one
  press."* Without Trivy the report says images were not checked, rather than
  quietly narrowing what "nothing found" means.

New findings arrive through the ordinary [alert channels](alerts.md). The same
finding is not repeated day after day; fixing it and regressing brings it back.

## SSH keys, and the toggle that matters

The single highest-value hardening act on a VPS is turning off password login for
SSH: it ends the dictionary attack that has been knocking on port 22 since the
machine went online. Every guide says to do it; almost nobody does, because it means
editing a config file over the very connection that file controls.

**Server → Who can sign in to this machine** shows the keys that can open the
machine (root's `authorized_keys`, public halves and OpenSSH fingerprints only),
takes a new one by paste, and offers password login as one switch. The guards:

- Passwords cannot be turned **off** while no key is on the list. There has to be a
  way back in before the door changes locks.
- The last key cannot be **removed** while passwords are off, for the same reason
  read the other way round.
- A pasted **private** key is refused loudly, with instructions to never do that.
- The change lands in `/etc/ssh/sshd_config.d/00-derailed.conf`, named to sort
  first because sshd honours the *first* occurrence of a directive and cloud images
  usually ship a `50-cloud-init.conf` already saying yes. On a machine whose config
  never includes that directory, the directives go between marked lines at the top
  of `sshd_config` instead.
- `sshd -t` proves the result parses before the daemon is asked to reload it, and a
  failed check puts every file back. Reload, never restart, so open sessions stay
  open whatever happens.

The screen also says, before you press it: open a second terminal and prove `ssh`
gets in without a password first. Derailed will not stop you being wrong about
that, and neither will anything else.

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

### Addresses Derailed will fetch on your say-so

Adding an app from a template link hands Derailed a URL and asks it to fetch it. The
request is then made by the server, from inside whatever network the server sits in,
which is a great deal more than the person who pasted the link can reach themselves: a
cloud metadata service on `169.254.169.254`, a database on the same Docker bridge, an
admin panel on the office LAN.

So the name is resolved before anything is opened, and every address it answers with has
to be on the public internet. Loopback, the RFC1918 ranges, link-local, unique-local,
carrier-grade NAT, the multicast and reserved blocks, and the unspecified address are all
refused. Resolving rather than reading the URL matters, because `internal.example.com` is
an ordinary-looking name that happens to answer `10.0.0.5`.

Redirects are followed by hand, one hop at a time, with the same check on each. The rule
used to be "https only" applied to the address that was typed and to nothing after it,
so an ordinary https link answering `302 Location: http://169.254.169.254/` walked past
it and arrived over plain http.

The **uptime monitor** is held to the same rule, and for the same reason: a member, not
only an owner, can add a domain and have Derailed fetch it on a timer from inside the
network. A name that resolves onto this machine or its private network is refused before
the connection is opened, so the check's own result, "answered" or "could not be reached",
cannot be turned into a scanner for the databases and admin panels the panel is meant to
keep to itself. It does not follow redirects at all, so a public name cannot bounce it
inward on a second hop either.

Alert channels and webhooks are deliberately *not* held to this. Those are owner-only,
and an owner pointing them at an ntfy server on their own LAN is a self-hosting setup
working as intended rather than an attack. The template fetcher and the uptime monitor
are the ones that take an arbitrary address from somebody who is not necessarily an owner,
and the line is exactly there: whether the address came from a hand that already has the
run of the machine.

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


## Two-step sign-in

**Settings → Signing in.** Scan the secret into any authenticator app, type the code it
shows, and from then on signing in needs your password and a six-digit code.

TOTP, to the letter of RFC 6238, so every authenticator app already works with it. The
secret is encrypted at rest like every other secret here.

You are shown **recovery codes** once, at the moment it is switched on. Each one signs
you in a single time. Write them down: without them, losing your phone means the only
way back is `derailed reset-password` on the server itself, which is a fine last resort
and a terrible only one.

Two details worth knowing:

- It is not switched on until you have proved a code from it. Scanning the QR and
  closing the tab leaves you exactly where you were, rather than locked out.
- Turning it off asks for your password again. A stolen session switching off the
  second factor is precisely what the second factor is for.

When a password is right but the code is missing, the answer is *"a code is needed"*
rather than an error. The browser has to know to ask, and "wrong password" would be a
lie. The rate limit is not reset until both have passed, so a correct password does not
buy unlimited attempts at the code.

A code is good for one sign-in and no more. TOTP accepts a code for its whole 30-second
step and one either side, which is a window wide enough to replay a code caught over a
shoulder or read off a proxy. So the step a sign-in actually used is remembered, and any
code at or before it is refused: the second attempt with the same six digits is turned
away even while they are still on the screen.

## Where you are signed in

The same page lists every session: the device, roughly, when it started, and the
address it came from. Anything that is not the one you are using can be signed out.

## Who did what

Every change is recorded: who, what, when, and from where. The "from where" is the same
trusted address the rate limiter uses, not the raw header, so a caller cannot stamp an
invented source IP onto their own line in the record. Reads are not recorded, because a
log of every page anybody looked at would bury the three lines that matter.

It is kept for a year and is on the **Settings** page. On a one-person server it is a
memory aid. The moment a second person has access, it is the difference between a
conversation and an argument.

## What each person can do

Three roles: an owner does anything, a member runs the apps without being able to delete
them or change the server, and a viewer changes nothing at all. The full line is in
[more than one person](people.md).

The check is one middleware in front of every route rather than a note on each one, and
that direction matters. A per-route check is a list of things somebody remembered; the
route added next Tuesday is not on it, and nothing fails until it matters. Here a new
route is covered the moment it exists, and widening access has to be written down on
purpose.

A few things worth being explicit about, because they are the places a role could be
walked around:

- **The terminal is closed to viewers.** A prompt inside a container would bypass every
  other restriction on them at once. Members do get one, and that is not an oversight:
  they can already deploy whatever code they like into that container.
- **The list of API tokens is owner-only, reads included.** A token acts as an owner, so
  the list of them is the list of keys to the machine.
- **A scheduled job with no app attached is owner-only.** It runs as a shell command on
  the machine rather than inside a container, so it is a way to do anything at all,
  including reading the database and the secret key. Until 0.9.0 the rules could not see
  this: the difference between "run this in my app" and "run this on the machine" is one
  field in the request body, and the rules match on paths, so a member could write one
  and press Run. The route now asks, and server jobs are hidden from a member's list and
  their output kept back, for the same reason the token list is.
- **A backup archive is treated like the token list.** It holds every database in the
  project in full, so downloading one is owner-only, reads included. Restoring one, which
  writes over what is live, and changing the retention that prunes every project at once,
  are owner-only too. Making, deleting and scheduling an individual backup stay a
  member's: the housekeeping is theirs, the data leaving or being overwritten is not.
- **Publishing a database to the internet is owner-only.** It opens a port on the machine,
  which is the server rather than the app, however much it reads like a per-database
  toggle.
- **A live secret is not a viewer's, even on a `GET`.** The "any read is fine for a
  viewer" shortcut has an exception for a read that hands back the thing itself rather
  than a view of it: an app's variables, a database's connection string. A viewer is the
  role for a client, and a client should not walk out with the keys.
- **The file browser is for apps, not databases.** A database keeps its data in a volume
  registered exactly as an app's storage is, so without a guard a member could delete the
  files under a running Postgres, the irreversible loss the owner-only volume rule exists
  to prevent, and a viewer could stream the database out a file at a time. Every `files`
  route refuses a database outright; its data is reached through Browse, snapshots and
  backups instead.

What roles are not is isolation. Everybody here sees every project, and a member can
deploy to any of them. If two people must not see each other's work, that is two
servers.

## Operating system security updates

The **Updates** page lists what the machine has waiting, and can apply it. There is
also a switch to apply the **security** ones by themselves, checked daily.

It is off until you turn it on. Updating somebody's server on a timer is a decision,
not a nicety.

What it does is deliberately narrow, because "automatic updates" means very different
things to different people and the gap between them is somebody's afternoon:

- **Security updates only**, never a whole-system upgrade. The full upgrade is still a
  button you press, which reads like the bigger decision it is.
- **Only where the package manager can tell the difference.** apt (through
  `unattended-upgrade`), dnf and yum (`--security`), and zypper (`patch --category
  security`) can. Pacman and apk cannot: Arch and Alpine ship one stream, and asking
  either for "just the security ones" gets you everything. On those two the switch
  says so and stays off rather than quietly upgrading the machine under a heading that
  says security.
- **It never reboots.** Some updates only take effect after a restart, and the right
  moment for that is a decision about your visitors rather than about packages.

### The restart notice

When a restart is needed, a line appears at the top of **every** page rather than only
on Updates. That is the whole point of it: a kernel patch applied three weeks ago and
never rebooted into is a machine running the old kernel and an owner who believes it is
patched.

It says nothing about when. Your apps come back on their own afterwards, and you choose
the moment.

## What is open to the internet

**Server → What is open to the internet** lists every port this machine is listening
on, from outside, with a line saying what each one is for:

- **80 and 443** are your websites, and the first is also how certificates renew.
- **The dashboard's port**, until you give it a domain and it moves behind HTTPS.
- **22** is SSH, and it says plainly that closing it locks you out of the server.
- **A published database port** names the database and says to close it on that
  database's Connection tab.
- **Anything else** says Derailed did not open it, names the process holding it where
  the machine will say, and suggests finding out what it is before closing anything.

Ports bound to loopback are left out. They are not reachable from anywhere, and listing
them buries the three that matter under a dozen that do not.

### Derailed does not change your firewall

It does not enable ufw, write iptables rules or touch firewalld, and that is a decision
rather than a gap.

A tool that manages a firewall on a remote server has exactly one catastrophic failure
mode: locking the owner out of the machine it is running on, with no way back in from
the web page that did it. The question people actually have here is "what is this port
and do I need it", and that can be answered completely without taking that risk.

Where Derailed opened a port itself, it says where to close it, because that is the one
case it can be certain about.
