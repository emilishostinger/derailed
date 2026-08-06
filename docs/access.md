# Who can see your apps

Every app has an **Access** tab. Everything on it is enforced by the proxy rather than
by the app, which is the point: WordPress, a folder of HTML and something written in a
language nobody here has heard of are all covered identically, and none of them has to
be changed.

## A password on a site

Set a username and a password, and visitors are asked for them before they see
anything. The browser does the asking, so there is nothing to add to your app.

This is the one that unlocks the most. Every staging site, every internal tool and
every "not ready yet" project needs exactly this and nothing more.

The password is hashed with bcrypt on the way in and never stored in the clear.
Derailed cannot show it to you again, and it is not included in anything the dashboard
receives. If you forget it, set a new one.

**It is not a login for your app.** It is a door in front of it. Anyone with the
password sees whatever your app shows to everybody, so it is protection from the
internet at large rather than a way of telling users apart.

## Only from certain addresses

A list of addresses and ranges that may connect. Anything else gets a plain refusal.

```
203.0.113.7        one address
203.0.113.0/24     a whole range
2001:db8::/32      IPv6 works too
```

Checked **before** the password, so somebody who is not allowed to be here is turned
away rather than invited to start guessing.

Leave the list empty to let everyone in. A malformed entry is refused when you add it
rather than accepted and pushed to the proxy: the proxy rejects a configuration it
cannot parse *wholesale*, so one bad entry in one app's settings would otherwise take
every site on the machine down.

## Maintenance

A switch that shows a short "back shortly" page instead of the app.

The app keeps running, so this is for the moments when you do not want anybody looking
rather than for stopping it. The page is served with `503` and `Retry-After`, so search
engines treat it as temporary and do not replace your real page with it, and with
`no-store`, so nobody's browser keeps showing it after you have switched it off.

While maintenance is on, nobody gets through, whatever else is set. The app is left out
of the request path entirely rather than sitting behind a handler that stops short of
it.

## What this is not

- **Not a firewall.** It covers traffic through the proxy. A database with an exposed
  port is a separate decision, made on its own tab.
- **Not encryption.** Put the app on a [secured address](domains.md) as well, or the
  password crosses the internet in the clear.
- **Not rate limiting.** Somebody determined can still guess at the password as fast as
  your server will answer.
