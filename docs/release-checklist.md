# Release checklist

CI covers the automatable parts. This is the list of things a machine can't check for us yet.

## Before tagging

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green **with Docker running**. The integration tests skip themselves silently
      without a socket, so a green run on a machine without Docker proves much less than it looks
- [ ] `VERSION` in `apps/server/src/config.ts` matches the tag you're about to push
      (the release workflow fails the build if it doesn't)
- [ ] The documentation in `docs/` matches what shipped, including the gaps
- [ ] Release notes written from the commit history

## The build

```sh
bun run build --target=linux-x64
bun run build --target=linux-arm64
```

- [ ] Both binaries produced
- [ ] `./derailed version` works on the host build

## Manual smoke test on a real VPS

This is the part that matters. A throwaway $5 Ubuntu box, destroyed afterwards.

- [ ] `curl -fsSL .../install | sh` on a **fresh** server with no Docker installed
- [ ] Installer installs Docker, starts the service, and prints a reachable URL
- [ ] Onboarding creates the account; signing out and back in works
- [ ] Create a project
- [ ] Deploy a repository **with** a Dockerfile → reachable at its generated address
- [ ] Deploy a repository **without** a Dockerfile (Nixpacks path) → reachable
- [ ] Build logs stream live while the deploy runs
- [ ] Deploy a deliberately broken repo → the error is in plain language and says what to do
- [ ] Add a real custom domain → DNS checklist is accurate → padlock appears without touching a
      terminal
- [ ] Add a PostgreSQL database → it reaches "Running"
- [ ] Connect the database to the app → redeploy → the app can read and write
- [ ] Stop, start and restart a service
- [ ] Roll back to a previous deploy
- [ ] Reboot the server → everything comes back up by itself
- [ ] `derailed update` from the previous release → `systemctl restart derailed` → data intact,
      apps never stopped
- [ ] Delete a database → warns clearly, removes the volume
- [ ] `derailed reset-password` works

## The dashboard

- [ ] Both themes checked on the topology view, drawer, and wizard
- [ ] `⌘K` finds projects, services and actions
- [ ] Topology canvas: drag-to-link works, "Tidy up" lays out sensibly, positions survive a reload
- [ ] Deploying a service animates on the canvas and settles when it's done

## Publishing

- [ ] Tag pushed (`git tag v0.1.0 && git push --tags`). The release workflow does the rest
- [ ] Release contains both binaries, `checksums.txt` and `install.sh`
- [ ] `sha256sum -c checksums.txt` passes against the published assets
- [ ] Install one-liner in the README points at the new release
- [ ] Screenshots in the README still match the UI
