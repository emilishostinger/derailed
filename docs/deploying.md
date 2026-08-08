# Deploying

Four ways to get something running: a repository, a zip, a Docker image, or a
ready-made app from the [catalogue](apps.md).

## Drag your project in

Drag the folder your project lives in onto the dashboard. Not a zip of it, not a
repository, just the folder. A zip works too if that is what you have.

It works for the things people actually write:

| | |
| --- | --- |
| **Node** | A `package.json` is enough. Your `start` script is used, and `PORT` is set for you |
| **Python** | A `requirements.txt`, `pyproject.toml` or `Pipfile`. Flask, Django, FastAPI |
| **PHP** | Including WordPress and anything else with an `index.php` |
| **A folder of HTML** | Served as a static site, no build at all |

No Dockerfile. Derailed reads the folder, works out what it is, says so in a sentence
before it starts, and builds it.

`node_modules`, `.git`, `.venv`, `__pycache__`, `dist`, `build` and friends are skipped
on the way up, so you do not have to tidy up first and the upload stays small.

If it guesses wrong, the app's **Settings** tab lets you say what it is instead.


## From a GitHub repository

Paste the link. Derailed clones it, works out how to build it, and tells you what it
found before you commit to anything.

### How the build is decided

In order, first match wins:

1. **A Dockerfile.** If the repository has one, it is used, and the `EXPOSE` line sets
   the port. Your build, your rules.
2. **A framework it recognises.** Next.js, Nuxt, Remix, SvelteKit, Astro, NestJS,
   Express, Vite, Django, Flask, Rails, Laravel, Go, Rust, Java, Elixir, Deno, Bun and
   plain Node. Each carries a sensible default port.
3. **A plain website.** A folder of HTML with no build manifest is served by nginx
   exactly as it is. A folder of PHP gets PHP 8.3 and Apache, with rewrites and the
   MySQL drivers. Neither needs a build step, so neither gets one.
4. **Anything else** goes to [Nixpacks](https://nixpacks.com), which inspects the
   project and generates a build.

The check for step 3 runs only after 1 and 2 have declined, because half the frameworks
in the world also keep an `index.html` at their root.

### The panel

Clicking an app opens a panel on the right with its logs, deploys, variables, storage,
domains and a terminal. Drag its left edge to make it wider, which is worth doing for
the log; the width is remembered. Double-click that edge to put it back.

### Settings that matter

On an app's **Settings** tab:

- **Branch**: which branch to build. Changing it takes effect on the next deploy.
- **Folder**: for a repository holding several things, the sub-folder to build from.
- **Port**: the port your app listens on. Detection fills this in; override it if your
  app disagrees.
- **Health path**: the path Derailed asks for to decide the app is up. Defaults to `/`.
  Anything that answers, even a 404, counts as alive; only a refused connection or a
  timeout is a failure.
- **Memory limit**: a ceiling, so one runaway app cannot take the machine down.
- **Deploy automatically**: whether pushing, or publishing a release, puts new code
  online on its own. See below.

### Deploying by itself

**Settings → Deploy automatically** on an app, which offers three answers:

| Choice | What happens |
| --- | --- |
| **Only when I ask** | Nothing until you press Deploy. The default. |
| **Every push to your branch** | Push, and the running app catches up within about two minutes. |
| **Only when I publish a release** | Ordinary commits are ignored; tagging a release deploys it, within about ten minutes. |

One choice rather than a switch for each, because they are not independent: deploying
every push already covers every release, so having both on would be a combination that
means nothing.

**Switching either on changes nothing today.** Derailed writes down where your branch
or your releases stand right now and waits for the next one, so turning it on never
redeploys an app that is already running.

These deploys are marked *a push* or *a new release* in the app's history, so it is
clear nobody pressed anything.

#### Every push

Derailed asks your git server where the branch is, every couple of minutes, using
`git ls-remote`. That is plain git rather than GitHub's API, which has two consequences
worth knowing: it works against **GitLab, Bitbucket, Gitea or your own git server**
just as well as GitHub, and it has no rate limit to run out of. Polling GitHub's API
this often would hit its sixty-an-hour ceiling with a handful of apps and then quietly
stop noticing anything.

A commit that fails to build is not tried again and again. Derailed writes down what it
saw before it starts building, so a broken commit is built once and then waits for the
next one, rather than filling the queue for ever.

#### Only when I publish a release

Releases are a GitHub feature, so this one does use GitHub's API and is offered only for
GitHub repositories. Drafts and prereleases are ignored: the tag has to be published and
marked as a full release. The deploy builds the release's tag rather than the branch, so
what runs is what was tagged, even if the branch has moved on since.

Use it when pushing and shipping are meant to be separate decisions.

#### Why polling rather than a webhook

A webhook would be faster by a minute or two, and would cost you a public URL, a shared
secret and a trip into every repository's settings. Plenty of servers running Derailed
are behind a router or somewhere GitHub cannot reach at all, and a webhook nobody is
watching usually ends its life having quietly stopped working. Asking every couple of
minutes needs no setup and cannot break in that direction.

### Private repositories

Add a fine-grained GitHub personal access token with read access to the repository on
the app's **Settings** tab. It is encrypted at rest and never sent back to the browser;
the dashboard only ever shows whether one is saved.

## From a docker-compose file

Half the self-hosted software on the internet ships as a compose file. Point Derailed
at a repository containing one, **Add something → Import a docker-compose project**,
and the file is read once and turned into the same objects every other project is made
of: each service a container on the map, its `volumes` as managed storage, its
`environment` in the Variables tab, `depends_on` as start order. You never edit the
YAML, and the YAML is never consulted again.

The import is two steps on purpose. **Look inside** clones the repository, reads the
file and shows the plan: which services, what each runs, what storage it keeps, and,
above all, what will *not* be honoured, said per service in plain language. Privileged
mode, host networking, devices, custom entrypoints and their friends are refused by a
managed server; the import says so on the screen before anything exists, rather than
failing at deploy time or quietly meaning something else. Then one press builds it.

Worth knowing:

- **The written names keep working.** A compose file's services find each other by
  name, underscores and all, and those names survive as network aliases. An app whose
  configuration says `my_db:5432` still finds its database without anybody editing
  anything.
- **Services without a web port are welcome.** A Redis, a worker, an app that only its
  nginx neighbour reaches: these never answer HTTP, so their health check is "keeps
  running" and no web address is generated for them.
- **Bound folders become fresh storage.** `./data:/data` mounts a folder of the
  machine the file was written for. That folder is not here; the import creates
  managed storage at the same path and says the contents did not come along.
- **`${VARIABLES}`** are filled from the `.env` beside the file, the way compose fills
  them. Anything unset comes through empty, with a note, and real values belong in the
  Variables tab afterwards.
- **Start order is creation order.** Compose's `condition: service_healthy` cannot be
  promised by a build queue; apps that retry their connections, which is nearly all of
  them, are fine, and the plan says so when a file relies on it.

## From a zip

Drag a zip onto the **Upload a website** option. Useful when there is no repository, or
no GitHub account at all.

- Up to 200 MB, unpacked on the server with no external tools.
- A single wrapping folder is unwrapped for you, so zipping a folder does the obvious
  thing.
- Entries that try to write outside the folder are refused.
- The files are kept, so **Deploy** rebuilds from them without a re-upload. Drag a new
  zip in to replace them.

The same detection applies: HTML is served as it is, PHP gets Apache, a `package.json`
gets built.

## From a Docker image

Give an image name like `caddy:2-alpine` or `ghcr.io/owner/thing:1.2`. Derailed pulls
it, runs it, and routes to the port you name. Environment variables go on the
**Variables** tab.

The Updates page notices when a newer image with the same tag has been published, and
can pull it and redeploy on request. It never does so on its own.

## What a deploy actually does

```
fetch → work out the build → build the image → start a container →
wait for it to answer → point the proxy at it → retire the old one
```

The new container is only routed once it answers, so a failed deploy is invisible to
visitors and the previous version keeps serving. That is also why there is no
"maintenance mode": there is nothing to put one in front of.

Every step streams into the **Output** tab while it happens, and stays there afterwards.

## Redeploying and rollback

- **Deploy** builds the current state of the branch again.
- **Deploys** lists previous deploys. Any successful one can be **rolled back** to,
  which re-runs its image without rebuilding. That is usually seconds.
- A deploy that fails leaves the running version alone.

If the app has data and no storage, Derailed asks before deploying, because replacing
the container is exactly when unstored files disappear. See [storage](storage.md).

## Environment variables

The **Variables** tab holds them. Values are encrypted at rest. Changes apply on the
next deploy, which the tab says plainly rather than pretending to be live.

Connecting a database to an app adds its connection details automatically as a
variable; see [databases](databases.md).

### Set once for the whole project

An API key, a timezone, an error-reporting address: things that are true of a project
rather than of one app in it. **Project menu → Shared variables** sets them once, and
every app in the project gets them.

Setting the same value on five apps by hand is five chances to fat-finger one, and
rotating it later means finding all five and remembering which they were.

**An app's own value wins.** A shared variable is a default, not a decree: an app that
needs a different one sets it on its own Variables tab and that is what it gets, with
no need to take anything off the project first. The other way round, a shared list
becomes something you have to fight the moment one app is different.

A connection detail Derailed injected also wins, for the same reason but more so: it
points at a real container, and a project-wide default of the same name would be a
guess.

Shared variables appear on each app's Variables tab under **Set for you**, greyed, so
the tab still answers the question it exists to answer: what will actually be set when
this runs.

## Limits, so one app cannot take the server down

**Project menu → Limits** sets a ceiling for every app in the project: memory in
megabytes, processor in cores.

A memory limit already existed per app, and had to be set per app, which means it got
set on the app somebody was already worried about and on none of the others. The app
that takes a box down is by definition the one nobody expected.

**Each applies per app, not shared between them.** A quota divided among apps changes
every time you add one, and the thing this is for is a single runaway process: capping
each container caps the damage, and the number keeps meaning the same thing next month.

**An app's own memory limit wins.** A number typed on the app's own settings was meant,
and a project ceiling quietly lowering it would make that field a lie.

The processor limit is a limit rather than a share, so a runaway loop is throttled
whether or not anything else happens to want the processor at that moment. Shares only
take effect under contention, which is one moment too late.

Both are given to a container when it starts, so each app picks the change up on its
next deploy.

## Builds, and the machine they run on

**Two builds do not run at once on a small server.** How many are allowed is worked
out from the machine: one per core, less one for everything else it is doing, and
never more than three however big the box.

On a single-core server that means one. Two builds there do not take half as long
each; they take longer than running them one after the other, because the time goes on
fighting over the core and the disk rather than on work. On a $5 box it is the
difference between a deploy that finishes and one killed for running out of memory
half way through. Past three the disk is the limit anyway, and more builders only means
more of them waiting on it.

A newer deploy of the same app still replaces an older one rather than queueing behind
it, which is unchanged.

**Layers are reused between deploys.** The image your app is running from is offered to
the builder as a source of layers, so a deploy that changed one line does not reinstall
every dependency.

That has to be named explicitly, because Docker's automatic cache only follows a
build's own parent chain, and Derailed breaks that chain itself: tidying up after a
deploy removes every image nothing is running. The image that *is* running is the one
image never pruned, which is why it is the one offered.

## When a build fails

The error is translated into what happened and what to do next, with the last lines of
build output underneath. The usual causes:

- **The repository is private** and no token is saved.
- **The build ran out of memory.** Building is the hungry part; 2 GB is a comfortable
  minimum for source builds.
- **The disk is full.** Old images are the usual culprit; Derailed prunes its own, but
  a machine that has been busy can still fill up.
- **Nixpacks could not work the project out.** Adding a Dockerfile always works.
