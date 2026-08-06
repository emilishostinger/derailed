# Deleting, and changing your mind

Deleting an app or a project does not destroy anything it stored. It stops the
containers, frees the web addresses, and puts the whole thing in the trash for a week.

That week is the point. Every other dangerous action in Derailed explains itself
before you take it, but a confirmation dialog is not much use at two in the morning,
and the folders holding your data are the one thing on the server nobody can get back.

## What happens when you press Delete

| | |
| --- | --- |
| **Stops** | Every container belonging to it, removed |
| **Frees** | Its web addresses, so they can be pointed elsewhere straight away |
| **Keeps** | Stored folders, database contents, environment variables, settings, deploy history |
| **For** | Seven days |

A toast appears at the bottom of the screen with an **Undo** button. Press it and
everything comes back, apps included, and any app that was running is redeployed.

If you miss the toast, the same thing is on the **Trash** page in the sidebar, for the
rest of the week.

## Putting something back

**Trash → Put it back.** The row says what is still there before you press it, because
"restore" is only worth pressing if you know what comes back.

Restoring an app that was inside a deleted project restores the project too. An app
cannot come back into a project that is still deleted: it would be listed nowhere,
routed nowhere, and impossible to find again.

Restoring a project brings back the apps that were deleted *with* it. An app you
deleted on its own last Tuesday stays in the trash, because deleting the project it
happened to live in was not a decision about that app.

## Emptying it

The trash empties itself. Anything older than seven days is removed for good, once a
day, and the removal is written to the log so there is a record of it.

**Delete now** on any row does it immediately. That is the one genuinely irreversible
button in Derailed, and it says so.

## What is not kept

- **Containers.** Removed at once. Restoring redeploys from the image, which is why a
  restored app takes a few seconds to come back.
- **Web addresses.** Freed at once, so they can be used elsewhere. A domain you own is
  never deleted, only detached; the automatic address is regenerated on restore.
- **Anything deleted before this feature existed.** It is not coming back. Sorry.

## Names

A deleted project keeps its name and its slug until the trash is emptied. Creating a
new project with the same name works, and it quietly gets a different address
(`shop-2` rather than `shop`), because two things cannot share one.

## Backups are still worth having

The trash protects against the mistake you notice within a week. It does not protect
against the disk failing, the server being rebuilt, or a mistake you notice in March.
See [backups](backups.md).
