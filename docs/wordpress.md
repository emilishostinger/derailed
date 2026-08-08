# WordPress superpowers

WordPress runs about half the web, which makes it the app most worth giving house
treatment. A WordPress app (any app running the official `wordpress` image, however
it got here) grows a **WordPress** tab with four buttons. Underneath all of them is
WP-CLI, WordPress's own command line, run in a throwaway container that borrows the
site's files, environment and network, so nothing is installed into the site itself.

## Sign in to wp-admin

One press opens wp-admin signed in as the site's first administrator. No password
typed, none changed.

How: a one-time token is stored in the site for five minutes, and a four-line
must-use plugin (written by Derailed, marked as such, safe to delete) exchanges it
for a signed-in session exactly once, then throws it away. A used or expired link
says so instead of a login form.

## Updates, backed up first

**Check for updates** lists what is waiting: plugins, themes, and WordPress itself,
with versions. **Update everything, backed up first** keeps the same promise app
updates keep: the whole project is backed up before anything moves, and if the copy
cannot be taken, nothing is updated. A failed update names the step that failed and
points at the backup.

## A staging copy

**Create a staging copy** builds a second site next to the first: the same image, a
real copy of the database (from the newest hourly copy), a real copy of the files,
its own address, and the links inside rewritten so it browses as itself. Break it
freely; it is an ordinary app underneath, so every screen works on it and deleting
it is deleting an app.

The copy's database is genuinely its own. Changing a title, a plugin, a theme on
staging changes nothing on the live site.

## Push staging to live

The fourth button is a restore in a party hat, and it behaves like one:

1. The **whole project is backed up first**. If the copy cannot be taken, nothing
   is pushed.
2. Staging's database and files become the live site's, deletions included.
3. The links are rewritten back, so the live site browses as itself.

Owner only, like every restore, because it writes over what is there now. The
staging copy stays afterwards for the next round; delete it like any app when done.
