# More than one person

**Settings → Who else can get in.**

One account was right when Derailed only had to let you in. It stops being right the
moment a freelancer wants to hand a client a link, or two friends share a box, or you
want somebody to be able to look at the logs without being able to delete the database.

There are three roles. Three, and no more: every extra one is a permission matrix
somebody has to hold in their head, and the questions people actually ask are only ever
"can they break it?" and "can they see it?".

## The three

| | What they can do |
| --- | --- |
| **Owner** | Everything. Change the server, decide who else is here, delete things. |
| **Member** | Run the apps: deploy, restart, read logs, change variables, add domains, take backups. Not delete an app or its storage, and nothing server-shaped. |
| **Viewer** | Look at everything. Change nothing at all. |

Whoever set the server up is an owner, and so is every account that existed before this
feature arrived.

### What "server-shaped" means

The line is drawn around the machine, not around the apps on it. A member who cannot
deploy is not a member. A member who can move the whole install to another server is an
owner with extra steps.

Owners only:

- Who else has access, and what they can do
- API tokens, because a token can do anything an owner can
- The server's own settings: its address, the dashboard's domain, the base domain for apps
- Updating Derailed itself
- Where alerts are sent, and how the server sends email
- Where backups go, and moving to another server
- The trash: emptying it, and putting things back
- Publishing a status page, because it is visible to anybody
- Deleting an app or a project
- Deleting storage, because what is inside it does not come back. An app can be
  deployed again from the same link in a minute; the database in its storage cannot.
- Scheduled jobs that run on the server rather than inside an app. Those are a shell
  command on the machine, so they are a way to do anything at all, and a member who has
  one has every entry above whether or not the list says so. Jobs *inside* an app stay
  a member's to write. See [jobs](jobs.md#jobs-that-belong-to-the-server).

Everything else is a member's to do.

## Adding somebody

**Add someone**, then their email address, a password to start with, and what they can
do.

There is no invitation email, and that is a decision rather than something unfinished.
Derailed has no outbound mail of its own to rely on, and a feature that silently does
nothing on a server with no relay configured is worse than one that never claimed to
work. Set the first password, pass it on however you already talk to that person, and
they can change it once they are in.

## Changing your mind

Change the dropdown on their row. It takes effect on their very next request: they do
not have to sign out and back in, and a member you make a viewer will find the buttons
refused a moment later.

**Remove** signs them out immediately, everywhere. Not at their next visit. Now.

## The things it will not let you do

**You cannot change your own access, or remove your own account.** Both are ways to end
up looking at a server you can no longer administer.

**The last owner cannot be demoted or removed.** A server whose every account is a
viewer cannot be fixed from the dashboard at all, because there is nobody left who is
allowed to promote anyone. Make somebody else an owner first, and the guard moves to
them.

## What a role does not do

It is not a wall between one person's apps and another's. Every member sees every
project on the server, and a member can deploy to any of them. Roles answer "what can
this person do", not "which things can they see". If you need two people who must not
see each other's work, that is two servers.

**A member can get a shell.** The terminal is open to owners and members, and this is
deliberate: a member can already deploy whatever code they like into that container, so
a prompt inside it hands them nothing they did not have a slower way of taking. A viewer
cannot, because it would walk around every other restriction on them at once.

**An API token still acts as an owner.** That has always been what a token means, and
scripts depend on it. Only an owner can make one, and only an owner can see the list.

## Forgotten passwords

On the server:

```
derailed reset-password you@example.com
```

With more than one account it will ask which, rather than guessing: silently resetting
somebody else's password and signing them out is the wrong kind of helpful.

## Who did what

Every change is recorded, whoever made it, and the record says which account. See
[Who did what](security.md#who-did-what).

## Through the API

| | |
| --- | --- |
| `GET /people` | Everyone, and which one is you |
| `POST /people` | `{ email, password, role }` |
| `PUT /people/:id/role` | `{ role }` |
| `DELETE /people/:id` | Removes them, and their sessions |
