# Domains and HTTPS

Three kinds of address, and they behave differently on purpose.

| | Looks like | Secured | Who owns it |
| --- | --- | --- | --- |
| **Your domain** | `example.com` | Yes | You |
| **Automatic address** | `shop.apps.example.com` | Yes | Given to each app, on your domain |
| **Free secure address** | `shop.my-server.duckdns.org` | Yes | Given to each app, free |
| **Temporary address** | `shop.203-0-113-7.sslip.io` | No, and never will be | Given to each app, free |

## Your domains

The **Domains** page manages the names you own. Adding one and choosing what answers on
it are separate steps, because in real life they happen days apart.

1. **Add a domain.** Type it. Derailed immediately checks where it points.
2. **Point it here.** Add an `A` record at your provider for the exact name shown,
   pointing at your server's IP. Derailed keeps checking; a new record can take a few
   minutes to reach everyone.
3. **Choose an app.** Once it points here, pick which app answers on it. You can change
   that later, or take the domain off an app without deleting it.

A domain you added outlives the app that used it. Deleting an app frees its domain
rather than taking it with you; the automatic address, which is part of the app, does
go.

### example.com and www.example.com

`www` is not a second domain. It is a property of the first one, so Derailed treats it
as one, and asks you nothing about it.

Add `example.com` and `www.example.com` is set up alongside it, redirecting there
permanently, over HTTPS, with its own certificate. **The address you type is the address
people see.** Type `www.example.com` instead and it works the other way round: that is
what visitors land on, and the bare domain sends them to it.

They are one row in the list, with a line underneath saying which way the redirect runs
and a **Swap** link to turn it around. The redirecting half needs its own A record, which
the row shows when it is missing.

Subdomains are left alone: `www.app.example.com` is nobody's address, so nothing is
offered for `app.example.com`.

If you added only one half before this existed, the row offers the other and explains
why: most people type `www` out of habit, and without it they get an error rather than
your site.

## Automatic addresses

Every app gets an address for free the first time it goes live. What that address looks
like depends on one setting.

### Without a domain of your own

You get `myapp.203-0-113-7.sslip.io`, the server's own IP spelled out.
[sslip.io](https://sslip.io) resolves any such name to the address inside it, so this
works with no DNS setup at all.

**It is plain HTTP and always will be.** Not from laziness: `sslip.io` is not on the
[public suffix list](https://publicsuffix.org), so Let's Encrypt counts every address
under it, worldwide, against a single allowance of fifty certificates a week. Asking
for one would usually fail, and when it worked it would take that allowance from
someone else.

### Without a domain, but with a padlock

You do not have to buy a domain to get HTTPS. In **Settings → A secure address, free**:

1. Open [duckdns.org](https://www.duckdns.org) and sign in with any of the buttons.
2. Type a name you like and press **add domain**.
3. Paste that name and the token from the top of the page into Derailed.

Every app then gets `shop.my-server.duckdns.org` with a real Let's Encrypt certificate,
and so does every app you deploy afterwards.

**Why this works when sslip.io cannot.** `duckdns.org` *is* on the public suffix list.
That one fact means Let's Encrypt treats `my-server.duckdns.org` as a registered domain
in its own right, with its own certificate allowance, rather than as one more name
sharing the single global allowance that every sslip.io user is already competing for.

Derailed asks for **one wildcard certificate**, `*.my-server.duckdns.org`, and proves it
by writing a DNS record rather than by serving a file over HTTP. So:

- One certificate covers every app you will ever deploy. Adding an app asks for nothing.
- Names are secured before they resolve anywhere, so there is no wait and no checklist.
- Nothing sits between your visitors and your server. Unlike a tunnel, traffic still
  arrives directly.

It renews itself, starting a month before expiry, so a failure has weeks of retries in
it rather than hours. Derailed also re-points the name at this server on every check, so
a machine that changes address does not quietly start sending visitors elsewhere.

The certificate is obtained by [lego](https://github.com/go-acme/lego), a single static
binary downloaded once into `/var/lib/derailed/bin` and checked against a digest
recorded in Derailed's source before it is run. The stock Caddy image ships no DNS
modules, and publishing a custom Caddy image would mean asking everyone to trust a
supply chain of our own.

If you later set a domain of your own, that wins: you went to the trouble of pointing it
here, and your name is nicer than a borrowed one.

### With a domain of your own

In **Settings → Addresses for your apps**, set a base domain such as
`apps.example.com`, having first added a wildcard `A` record:

```
*.apps.example.com.   A   203.0.113.7
```

Derailed verifies the wildcard by asking for a name nobody would ever create by hand,
then gives every app an address like `shop.apps.example.com` with a real certificate.
Apps that already exist pick one up straight away and keep their old address, because
someone has probably shared it.

This is the setting that makes "everything I host is on HTTPS" true without touching
DNS again.

## Certificates

Caddy gets and renews them from Let's Encrypt over HTTP-01. There is nothing to
configure and nothing to renew by hand.

The one exception is the free secure address above, whose wildcard Derailed obtains
itself over DNS-01 and hands to Caddy. Caddy is explicitly told not to manage those
names: it would try over HTTP, fail on a wildcard, and retry until the allowance was
gone.

A name is only given to Caddy once DNS actually points at this server. Otherwise Caddy
would ask for a certificate it can never be issued, and repeated failures count against
your allowance.

Anything with a certificate also redirects `http://` to `https://`, with the ACME
challenge path excluded so renewal ninety days from now does not walk into its own
redirect.

## How the DNS check works

Derailed asks Cloudflare and Google over DNS-over-HTTPS rather than the machine's own
resolver, which on a VPS is often stale or answers for the machine's own hostname.

Every resolver is asked and any positive answer settles it. A resolver asked before a
record existed remembers "no such name" for as long as the zone says, often ten
minutes, so trusting whichever answered first told people their brand new record did
not exist.

Statuses you will see:

- **Points here**: correct, and it will be routed.
- **Points somewhere else**: the name resolves, but not to this server.
- **Doesn't point anywhere yet**: no record found. Normal for the first few minutes.
- **Checking…**: no answer from any resolver, usually a network problem on the server.

## The dashboard's own address

Settings → Dashboard address puts the panel itself behind a domain with HTTPS. Until
then, signing in sends your password in the clear. The IP and port keep working as a
way back in if the domain ever breaks.


## Several apps on one domain

A domain normally points at one app. It can instead be split by path, so different
parts of one address are different apps:

```
example.com/          →  your marketing site
example.com/blog      →  WordPress
example.com/api       →  your backend
```

On each app's **Domains** tab, add the same domain, then choose **Put it on a path
instead** and type `/blog`.

The longest path wins, so `/api/v2` is reached even though `/api` also matches, and the
whole-domain app only gets what nothing else claimed. A prefix matches itself and
everything under it: `/blog` catches `/blog` and `/blog/anything`, but not `/blogging`.

**One honest caveat.** Derailed delivers the request to the right app. Whether that app
can *serve* from a sub-path is the app's own business, and many cannot without being
told. WordPress has a site address setting, Ghost has `url`, Next.js has `basePath`.
An app that does not know it lives at `/blog` will generate links to `/` and appear
half-broken. Set the app's own base path to match and it works.

Apps that serve static files, and APIs, usually need nothing.
