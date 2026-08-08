# Uptime, and a page you can share

Derailed already knew whether a container was running. That is a different question
from whether your site works, and it is not the one anybody is asking: a container can
be running perfectly while it serves five hundreds, or while its certificate has
quietly expired underneath it.

So every five minutes Derailed makes the request a visitor would make, and keeps the
answer for ninety days.

## What counts as up

Anything from `200` to `399`, and `401`.

A redirect is up: `example.com` sending people to `www.example.com` is a site that
works. A password prompt is up too, because a
[protected site](access.md) is answering, not failing.

Everything else is down, with the reason in words: *did not answer in time*, *its
certificate was refused*, *answered 502*.

One refinement, opt-in per app: if the app's health check (in its Settings) says
*its answer contains a text*, the monitor holds the live site to the same words. A
`200` that no longer says them is an app serving its error page dressed as success,
which is exactly the outage a status code cannot see, and it is reported as
*answered, but never said "…"*.

## The bar

Ninety days, one block each: green for a clean day, amber for a wobble, red for a bad
one. Hovering gives the exact figure and the average response time.

Percentages are **rounded down**. A day with 99.95% shows as 99.9%, never 100%,
because a status page claiming perfection on a day something broke is worse than one
admitting a dip.

## A page you can share

**Uptime → Publish a status page** puts a page at `/status` on your dashboard's own
address, readable by anybody with no sign-in. The exact address to send people is
shown on the Uptime screen once you switch it on, with a button to copy it.

It is one self-contained page: no scripts, no fonts, no request to anywhere. That is
deliberate, because this is the page people open when everything else is broken, and
it must not depend on the dashboard's assets loading or on anything being reachable.

The same thing is at `/api/public/status.json` if you would rather point a monitoring
service at it, or build your own page from it.

It never claims things are fine before it knows. A page that says "all systems
normal" when nothing has been checked yet is the one sentence that would make the
whole thing not worth reading, so it says "not checked yet" instead, and
"everything checked is up" when some addresses are still pending.

It is off until you switch it on, and it is deliberately narrow. It says:

- The name of each address you own
- Whether it is up
- Ninety days of daily percentages
- The title you chose

It does **not** say anything about your projects, your apps, your versions, how many
of anything you run, or why something failed. A failure reason can name an upstream, a
port or a container, and none of that belongs on a page anybody can read.

## Which addresses appear

Domains you added yourself, and not the automatic ones. That default is not tidiness:
an automatic address has this server's IP written into it, so publishing one tells
anyone reading the page where the machine lives.

It is a default rather than a rule. The Uptime screen lists every address with a tick
box, so you can put an automatic one on there if you would rather have a working status
page than a hidden IP, and take a bought one off if it is not for the public. The
warning is on the screen next to the ones that disclose an address.

If nothing is ticked, the screen says so, rather than leaving you with a published page
that is silently empty.

## Alerts

A site that stops answering raises an [alert](alerts.md), separately from a crash.
That distinction matters: an app whose container is running while its site answers
nothing is exactly the case a crash alert cannot see.

## Only public addresses

The monitor makes its request from the server, on a timer, and the server sits inside a
network your apps and databases share. So a name that resolves onto this machine or its
private network is refused before the request is made, rather than quietly reporting
whether the thing behind it answered. It is the same rule the template fetcher follows,
and it is here for the same reason: the address is one a member can set, not only an
owner, and the panel should not become a way to knock on the doors it is meant to guard.
See [security](security.md#addresses-derailed-will-fetch-on-your-say-so).
