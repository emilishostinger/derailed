# Visitor figures

Every app has a **Visitors** tab: how many visits and people, how much data was sent,
how quickly it replied, which pages were read, where people came from, and how requests
ended.

There is no script in your pages. Nothing is loaded from a third party. Nothing about
your visitors leaves the machine.

## How it works

Caddy is already in the path of every request, so it writes one JSON line per request
to a file inside `/var/lib/derailed/access-logs`. Derailed reads the new bytes every
fifteen seconds, turns them into counters, and forgets the lines.

The rolled-up figures are all that is kept:

| Kept | For how long |
| --- | --- |
| Visits, data, timing and status per hour | 90 days |
| Pages and referrers per day | 90 days |
| One row per visitor per hour | 45 days |

Caddy's own log file rolls at 8 MB and keeps one previous file, so the raw lines are
gone within hours on any busy site and immediately on a quiet one.

## How a visitor is counted

A visitor is the address a request came from, hashed with a key that never leaves this
server, kept as 24 characters. The hash cannot be turned back into an address without
the key, and nothing else about the person is stored at all.

The hash deliberately does not include the date. Rotating it daily would be marginally
more private, and would also make one person visiting all week count as seven, which is
the number most analytics quietly report and nobody believes.

## What is deliberately not kept

- **Query strings.** `/search?q=someone@example.com&token=secret` is counted as
  `/search`. Query strings carry tokens and names.
- **Referrer paths.** Where someone came from is recorded as the site,
  `news.ycombinator.com`, never the page they were reading on it.
- **User agents.** Used once to decide whether the request was a crawler, then dropped.
- **Anything per-request.** There is no log to page through, by design.

Long paths are trimmed, and at most 500 distinct paths and referrers are tallied per
day, so a crawler walking a million generated URLs costs a bounded amount of disk.

## Crawlers

Requests from obvious bots — Googlebot, crawlers, `curl`, `wget` and friends — are
counted separately and kept out of every other figure. The tab says how many there
were. Every counter above that line is about people, which is why the status breakdown
adds up to exactly the number of visits.

## Reading it

- **Visitors** — distinct people over the whole range, not the sum of the days.
- **Visits** — requests from people, including images and stylesheets. A page view is
  not the same thing.
- **Typical reply** — the mean time Caddy took, in milliseconds. It measures your app,
  not the visitor's connection.
- **How it went** — served, redirected, not found, or the app broke. A count under "the
  app broke" is worth looking at the Output tab for.

## Limits, honestly

- Figures start when the app first gets a request after this feature existed. There is
  no backfill; the data did not exist before.
- Requests that never reach Caddy are invisible, which includes anything served from a
  visitor's own cache.
- Bot detection is a list of the obvious ones. A crawler pretending to be a browser is
  counted as a person, the same as everywhere else.
- Counting per app means counting per hostname. Two apps sharing a hostname cannot be
  told apart, but Derailed does not let that happen anyway.
