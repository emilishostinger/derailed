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

**Add mine** fills in the address you are reading the dashboard from. Almost nobody
knows their own public address, and the usual ways to find out are a search engine and
a third-party site; asking the server you are already talking to is easier and more
private than either.

## Never from certain addresses

The opposite list, and the question people usually arrive with: one address hammering
the login page, one bot ignoring `robots.txt`. An allow list cannot express that
without naming every visitor you have ever had.

Same format as the allow list, and checked **before** it, so a block wins over an
invitation. Somebody on both lists is not welcome; that is the reading nobody has to
think about.

Blocking the address you are browsing from is refused the first time, with the reason,
and accepted if you press again. It is usually a paste of the wrong line, and the page
it would lock you out of is the page you would have to come back to in order to undo
it. But somebody blocking a range their own ISP happens to be in has a real reason, so
it is a speed bump rather than a wall.

## What is true right now

The top of the tab says what the combination of these settings actually does, in one
sentence: "Anyone on the internet can see this", or "Visible only from 2 addresses, and
only with the password". Four settings that interact is four things to hold in your
head, and the reading that matters is the combination rather than any one switch.

## Maintenance

A switch that shows a short "back shortly" page instead of the app.

The app keeps running, so this is for the moments when you do not want anybody looking
rather than for stopping it. The page is served with `503` and `Retry-After`, so search
engines treat it as temporary and do not replace your real page with it, and with
`no-store`, so nobody's browser keeps showing it after you have switched it off.

While maintenance is on, nobody gets through, whatever else is set. The app is left out
of the request path entirely rather than sitting behind a handler that stops short of
it.

## Bots

The 2026 complaint: AI scrapers hammer small sites hard enough that people notice
their box working at night. The Access tab's **Bots** section is the answer, and it
stays out of the request path: the walls are enforced by the proxy from configuration,
and Derailed only reads the traffic figures it was already reading.

**Slow down whatever asks too fast** has three positions:

- **Off** asks nothing of anybody.
- **Polite** only reacts to clearly automated traffic: an address making hundreds of
  requests a minute, sustained.
- **Strict** reacts to heavy traffic from one address, which catches the scrapers that
  pace themselves.

An address over the line gets a challenge page: a small proof of work its browser
solves by itself in about a second, invisibly, after which that address is waved
through for hours. A person meets it at most once on a busy afternoon; a scraper pays
for it per address, in CPU, which is the one currency scraping farms actually spend.
An address going five times harder than the line is plainly a script and is turned
away outright for half an hour.

Honest print: the walls are raised from recent traffic, read every few seconds, so a
short burst gets through before the wall goes up. Sustained hammering, the thing
people actually complain about, meets the wall about fifteen seconds in. And a visitor
without JavaScript who is unlucky enough to get challenged sees a page explaining
exactly that, rather than a silent refusal.

**Turn away AI scrapers** blocks the crawlers that read sites to feed models, by the
names they announce: GPTBot, ClaudeBot, CCBot, Bytespider, PerplexityBot and the rest
of the current list, with `robots.txt` telling them not to try (this shadows the
site's own robots.txt while it is on). A crawler that lies about its name walks past a
name list; the rate walls above are for those.

The [visitor figures](analytics.md) grow a bots-versus-people split on the chart, so
the toggle has a number attached: colour is people, grey on top is the crawlers.

## What this is not

- **Not a firewall.** It covers traffic through the proxy. A database with an exposed
  port is a separate decision, made on its own tab.
- **Not encryption.** Put the app on a [secured address](domains.md) as well, or the
  password crosses the internet in the clear.
- **Not per-request rate limiting on the password.** Somebody determined can still
  guess at a site password quickly; the bot walls slow sustained hammering, not a
  short burst of guesses.
