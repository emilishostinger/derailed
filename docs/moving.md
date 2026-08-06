# Moving to another server

People hesitate to commit to a tool that makes their setup unportable, and the
hesitation is reasonable: a year of small decisions living only in one machine's
database is a year you cannot get back if the machine goes.

So this is the answer to *"what if this project dies"*, and being able to say it out
loud is most of the point.

## Taking it with you

**Settings → Moving to another server → Make the file.**

You get one `.tar.gz` containing:

```
derailed.json    every project, app, database, domain, storage folder and setting
backups/         one ordinary backup per project, openable with tar
README.txt       what all of it is
```

It is worth having whether or not you ever move: it is a complete, readable copy of
everything on the machine, in formats that will still open in ten years.

## Moving in

On the new server, **Settings → Moving to another server**, and upload the
`derailed.json` from inside that file.

Everything is recreated: the projects, the apps, the databases, the storage folders,
the domains. **Nothing is started.** Importing a plan should never be the moment a new
machine begins pulling images and taking traffic, so you deploy each app when you are
ready.

Anything already on the machine is left alone rather than merged. Importing twice, or
importing onto a server that is already doing something, cannot quietly change what is
there.

## What does not come across

**Variable values.** Their names do, listed and empty, so it is obvious what has to be
filled in. The values are encrypted with a key that lives on the old machine, and
putting them into a file somebody emails themselves would undo the entire reason they
were encrypted.

The same is true of database passwords and repository tokens. New databases get fresh
passwords; private repositories need their tokens adding again.

## Afterwards

The import tells you, but in short:

1. Point your domains at the new server. Each needs its `A` record changing.
2. Fill in the variables.
3. Add tokens for private repositories.
4. Restore each project's backup, from the `backups/` folder, on the Backups page.
5. Deploy each app once.

Keep the old server running until the new one is answering. Nothing about this is
destructive to the machine you are leaving.


## Bringing in what is already here

A machine that already runs containers is not a dead end. Derailed lists everything it
did not start under **Also on this server** on the dashboard, and each one has a
**Take it over** button.

Adopting is deliberately shallow. The container is not restarted, relabelled or
rebuilt: it keeps running exactly as it was, started however you started it. What it
gains is a place in Derailed: a web address, a certificate, the uptime check, and a
node on the map.

**What it does not gain is deploys.** Derailed did not build it and does not know how,
so there is no redeploy button and no repository behind it. Point Derailed at the
repository as a new app when you want that.

The port is guessed conservatively: the familiar web ports first, then anything that
is not obviously a database, then nothing at all. An address pointed at Postgres
answers with binary nonsense, which is a worse first impression than an empty field.
