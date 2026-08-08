# What will change

Editing a live server is a series of small leaps of faith: change a variable, add a
domain, tweak a port, and each one lands the moment you press Save. Most days that is
exactly right. Some days, the day you are rotating a key across four apps, or setting
up a domain move you want to happen all at once, it is not.

**Project menu → What will change** puts one honest screen between editing and
production. Switch on *Collect changes for review* and, for that project, edits stop
landing one by one:

- **Variables** (an app's, and the project's shared ones)
- **Settings** (port, branch, health check, memory, all of the Settings tab)
- **Domains** (pointing a new address at an app)

Each save answers "saved for review" instead of applying, and the project page grows
a quiet pill: *3 changes waiting, review and apply together.*

## The review screen

Every waiting edit is shown as a sentence and a diff a person can read:

> **Variables on shop**
> `API_KEY changed` · `NEW_FLAG added`
>
> **Settings on shop**
> `port: was 3000, now 8080`
>
> **shop.example.com will point at shop**

Variable **values appear nowhere**, deliberately: which keys move is the story, and
the values are secrets. Settings show their values, because a port is not one.

One **Apply** lands everything, oldest first, through exactly the code the live save
would have used, re-validated on the way, because the world may have moved since the
edit was staged. An edit whose app has since been deleted, or whose domain has been
taken, reports its reason in a sentence and stays in the queue; the rest still land.
Three good changes never wait on one stale one.

Saving the same thing twice while the first save waits replaces it. Turning review
off keeps whatever is waiting rather than quietly applying or binning it.

## The history

Whether or not review is on, every applied variable save is recorded: **when, by
whom, and which keys** were added, changed or removed. Never the values. It is under
*What changed before* on the Variables tab, and it exists because the night after
something broke, the first question is "what changed and when", and until now
Derailed knew and did not say.
