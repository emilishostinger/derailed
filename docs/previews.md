# A copy of your app for every branch

Turn this on and every branch in your repository gets its own running copy of the app,
at its own address. Push a branch, and a few minutes later there is a link you can send
someone. Delete the branch, and the copy goes with it.

This is the feature people pay twenty pounds a month for elsewhere. Every piece of it
was already here: Derailed polls your repository for pushes, runs a container per app,
and hands out an address to anything new. The only new idea is that a branch is a
temporary copy of an app.

## Turning it on

**Your app → Settings → Branches → Give every branch its own copy.**

It only appears for apps deployed from a repository. There is nothing to configure: no
naming pattern, no branch filter, no list of which branches count.

Within five minutes the first copies appear. Each one is an ordinary app in the same
project, named after the app and the branch, so `shop-web · dark-mode` sits next to
`shop-web` in the sidebar.

## What a copy gets

| | |
| --- | --- |
| **The same code** | Built from the branch, the same way the real app is built |
| **The same variables** | Everything you set by hand comes across, so it can actually start |
| **The same database** | It connects to the real one, not a copy |
| **Its own address** | An automatic one, with HTTPS, like any other app |
| **Everything else** | Logs, terminal, metrics, the file browser. They are ordinary apps |

They are ordinary apps on purpose. Every screen in Derailed already works on them, and
none of those screens had to be taught what a preview is.

## The database is shared

A copy connects to the real database. It is not given one of its own.

This is a deliberate limit, and worth knowing before you use it. A database per branch
sounds better until you have to migrate each of them, seed each of them, and work out
why the copy from March will not start. The honest version of this feature at this size
is **the same data, the other code**, which is what you want when the branch changes a
template and is a hazard when it changes a schema.

So: a branch that adds a column will add it to your real database when it runs its
migrations. Treat a preview as something with real access, because it has real access.

## Deleting

When a branch goes, its copy goes within five minutes: containers removed, address
freed. That is the part people forget to do by hand, and the reason a server ends up
with eleven copies of work that finished in March.

The copy goes to the [trash](trash.md) rather than being destroyed, so a branch deleted
by mistake is not a copy whose logs vanished before anyone read them. It clears itself
after a week like anything else.

Turning the toggle off does the same thing to every copy at once. The real app is never
touched.

## Things worth knowing

**Your default branch never gets a copy.** It is the app itself.

**No webhook, no public URL.** Derailed reads the branch list from your repository
directly, the same way it notices a push. It works on a server GitHub cannot reach.

**A repository it cannot read changes nothing.** If the network is down or a token has
expired, Derailed leaves every copy exactly where it is rather than treating "I could
not ask" as "there are no branches".

**Each copy is a real container.** Ten branches is ten apps' worth of memory. If that is
a problem on a small server, sleeping is the other half of this feature: copies nobody
is looking at pause on their own.

## Through the API

| | |
| --- | --- |
| `GET /services/:id/previews` | Whether it is on, and the copies that exist |
| `PUT /services/:id/previews` | `{ enabled }` |
