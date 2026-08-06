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

## The bar

Ninety days, one block each: green for a clean day, amber for a wobble, red for a bad
one. Hovering gives the exact figure and the average response time.

Percentages are **rounded down**. A day with 99.95% shows as 99.9%, never 100%,
because a status page claiming perfection on a day something broke is worse than one
admitting a dip.

## A page you can share

**Uptime → Publish a status page** makes `/api/public/status.json` readable by
anybody, with no sign-in. Send it to a client, put it in a README, point a monitoring
service at it.

It is off until you switch it on, and it is deliberately narrow. It says:

- The name of each address you own
- Whether it is up
- Ninety days of daily percentages
- The title you chose

It does **not** say anything about your projects, your apps, your versions, how many
of anything you run, or why something failed. A failure reason can name an upstream, a
port or a container, and none of that belongs on a page anybody can read.

Only domains you added yourself appear. The automatic addresses are left off: they are
working URLs, not ones you would put on a status page.

## Alerts

A site that stops answering raises an [alert](alerts.md), separately from a crash.
That distinction matters: an app whose container is running while its site answers
nothing is exactly the case a crash alert cannot see.
