# Leaving Heroku (or Render, Railway, Fly)

Heroku went into maintenance mode in February 2026, and a lot of people are working out
where their apps live next. If that is you: welcome. This page is the whole move, in
order, with the honest costs.

## The arithmetic

A Heroku app that matters usually runs at least one Standard dyno and a Standard
Postgres plan; call it $75 a month before Redis, and $100 with it. The same app on a
$6 to $12 VPS with Derailed on it is the same app: the dyno is a container, the add-on
is a Postgres running next to it, and the router in front is Caddy with real
certificates. The server page in the dashboard shows this arithmetic against your
actual apps once they are running.

What you give up is the fleet behind the curtain: multi-region, one-click horizontal
scale, someone else's pager. Derailed is one server, on purpose. If your app has
outgrown one good server, this is not your product, and that is a happy ending too.

What you get back, besides the difference in money, is that nothing here can be put
into maintenance mode under you. It is your machine, an ordinary binary, and backups
that are ordinary files.

## The move, in order

1. **Get a server.** Any VPS with 2 GB of RAM and any recent Linux. Run the one-line
   installer from the [install guide](install.md); it brings Docker, Derailed and the
   router, and prints the dashboard address.
2. **Import the app.** In a project, **Add something → Import an existing setup**, and
   paste the repository link. Derailed reads the `app.json` and `Procfile` (or
   `render.yaml`, `railway.json`, `fly.toml`) and shows you the plan: each Procfile
   process as a service, each add-on as a database of the right engine, wired in under
   the same variable names. Nothing is created until you press the button.
3. **Paste the secrets.** The plan carries variable *names*, never values, because the
   platform never wrote the values into the repository either. `heroku config` prints
   them; each app's **Variables** tab is where they go. Generated secrets
   (`generator: secret` in `app.json`) are generated fresh for you.
4. **Move the data.** One dump each way:

   ```sh
   heroku pg:backups:capture --app my-app
   heroku pg:backups:download --app my-app
   ```

   Then load `latest.dump` into the new database with the `pg_restore` command the
   database's **Connection** tab shows, pointed at the file. For Redis the honest
   answer is to let the cache warm itself; it is a cache.
5. **Point the domain.** Add your domain to the app and follow the on-screen
   checklist; the certificate arrives on its own. Keep the Heroku app running until
   DNS has moved, then scale it to zero and watch the invoice stop.

## What maps to what

| On Heroku | Here |
| --- | --- |
| A dyno / Procfile process | A service in a project; `web` answers HTTP, the rest just run |
| `heroku-postgresql` | A PostgreSQL from the catalogue, address injected as `DATABASE_URL` |
| `heroku-redis` | A Redis, injected as `REDIS_URL` |
| Config vars | The Variables tab, names pre-filled by the import |
| Heroku Scheduler | Scheduled jobs on the app, with run history |
| `git push heroku main` | Deploy on push, from the repository it already lives in |
| Review apps | Branch previews |
| Rollback | Rollback, plus updates that back up first |
| The release phase | Not run automatically; run it from the Terminal tab when a deploy needs it |

Render, Railway and Fly land the same way from their own files; each import says
plainly what its file could not tell it (Railway keeps variables in its dashboard, Fly
keeps Postgres as a separate app), so nothing goes quietly missing.
