# Domains and HTTPS

Three kinds of address, and they behave differently on purpose.

| | Looks like | Secured | Who owns it |
| --- | --- | --- | --- |
| **Your domain** | `example.com` | Yes | You |
| **Automatic address** | `shop.apps.example.com` | Yes | Given to each app, on your domain |
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

Adding an apex domain asks whether to handle `www` too, and which of the two people
should see. The other redirects to it permanently, over HTTPS, with its own
certificate. They show as one row, and there is a link to swap which is which.

This is one question asked once, rather than two addresses that answer independently
and disagree about which is canonical.

### example.com and www.example.com, after the fact

If only one half is set up, the domain's card offers the other and explains why:
most people type `www` out of habit, and without it they get an error rather than
your site.

Once both exist, **Which one do people see?** picks the address visitors end up at.
The other sends them there, so a link shared anywhere lands in the same place. The
redirecting half needs its own A record, which the card shows underneath.

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
