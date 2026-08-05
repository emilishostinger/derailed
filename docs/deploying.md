# Deploying

Four ways to get something running: a repository, a zip, a Docker image, or a
ready-made app from the [catalogue](apps.md).

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

### Private repositories

Add a fine-grained GitHub personal access token with read access to the repository on
the app's **Settings** tab. It is encrypted at rest and never sent back to the browser;
the dashboard only ever shows whether one is saved.

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

## When a build fails

The error is translated into what happened and what to do next, with the last lines of
build output underneath. The usual causes:

- **The repository is private** and no token is saved.
- **The build ran out of memory.** Building is the hungry part; 2 GB is a comfortable
  minimum for source builds.
- **The disk is full.** Old images are the usual culprit; Derailed prunes its own, but
  a machine that has been busy can still fill up.
- **Nixpacks could not work the project out.** Adding a Dockerfile always works.
