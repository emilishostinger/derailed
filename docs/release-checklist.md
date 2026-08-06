# Release checklist

CI covers the automatable parts. This is the list of things a machine can't check for us yet.

## Before tagging

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green **with Docker running**. The integration tests skip themselves silently
      without a socket, so a green run on a machine without Docker proves much less than it looks
- [ ] `VERSION` in `apps/server/src/config.ts` matches the tag you're about to push,
      **and** the `version` field in the root and workspace `package.json` files. These
      drifted once already: the binary said 0.1.1 while every package.json still said
      0.1.0
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
- [ ] `⌘K` finds projects, services, actions and pages of the handbook
- [ ] Topology canvas: drag-to-link works, "Tidy up" lays out sensibly, positions survive a reload
- [ ] Deploying a service animates on the canvas and settles when it's done

## Publishing

Done by hand for now. There is no release workflow in `.github/`, whatever an earlier
version of this page implied.

```sh
cd dist-release
sha256sum derailed-linux-x64 derailed-linux-arm64 > checksums.txt
gh release create vX.Y.Z derailed-linux-x64 derailed-linux-arm64 checksums.txt \
  --title "vX.Y.Z" --notes-file notes.md
```

- [ ] Tag pushed (`git tag vX.Y.Z && git push --tags`)
- [ ] Release contains both binaries and `checksums.txt`
- [ ] `checksums.txt` was generated from the binaries actually uploaded. The installer
      and `derailed update` both refuse a release whose checksum is missing or wrong,
      so a stale one is a broken release, not a warning
- [ ] Install one-liner in the README points at the new release
- [ ] Screenshots in the README still match the UI
