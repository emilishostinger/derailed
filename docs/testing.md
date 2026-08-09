# Testing

The bar here is not a test count, it is whether a test would *fail* if the thing it
guards broke. A suite that runs a lot of lines and asserts nothing is decoration. So
the shape of this is: fuzz the boundaries, example-test the behaviour, and prove the
whole thing green somewhere that actually has Docker.

## Running it

```sh
bun run test                  # the whole suite (serial); with Docker up, this is what CI runs
bun test ./apps/server/test/net.test.ts   # one file
bun test --coverage           # the whole suite with the coverage report
DOCKER_SOCKET=/tmp/nope bun test --parallel   # units only, isolated (no Docker; see below)
```

Three things worth knowing:

- **Serial with Docker; `--parallel` only without it.** The server keeps a few
  process-wide singletons (the database handle in `db/index.ts`, the rate limiters in
  `routes/auth.ts`), and a plain `bun test` runs all ~115 files in one process where
  those are shared. That is fine as long as the files do not overlap, and with Docker up
  the container tests make the run slow enough that they don't: each unit file starts
  well after the last one finished. Without Docker the container tests skip, the run is
  fast, and files can overlap: one file's teardown or a late async callback swaps the
  shared database out from under the next file's request, which then 401s because the
  session it just created is in a database that is no longer current. For that case
  `--parallel` gives each file its own worker process and its own copy of everything, so
  the units are deterministic. It is **not** for a run with Docker, though: the
  integration tests share one fixed test-Caddy (name, network, ports), so two of them at
  once fight over it. So: Docker up → serial (`bun run test`); no Docker → `--parallel`.
  CI has Docker and runs serial.
- **Run it from the repo root.** `bunfig.toml` preloads `apps/server/test/setup.ts`,
  which gives every run its own throwaway data directory (so nothing touches
  `/var/lib/derailed` or your `.dev-data`) and its own Caddy name, network and ports.
  Run it from a subdirectory and the preload does not fire.
- **The integration tests skip themselves without Docker.** Files ending
  `.integration.test.ts` check for a Docker socket and turn into no-ops when it is not
  there. That is why a green run on a laptop without Docker proves less than it looks:
  the container-touching half simply did not run.

CI runs the integration tests too, serially, but as a best-effort step rather than a
gate. Most pass on the hosted runner; a handful (the Caddy tests, a couple of
engine-connection tests) need host networking that GitHub's Docker does not give a
container the way a real Docker host does, and they pass on a real box. That box is the
point of the VPS smoke test in `docs/release-checklist.md`, which is where the deploy
path is actually proven. The hard CI gates are typecheck, lint, and the isolated unit
suite with its coverage floor.

## What runs where

| Kind | Marker | Needs |
|---|---|---|
| Unit / property | plain `.test.ts` | nothing but Bun |
| Integration | `.integration.test.ts` | a Docker socket; pulls its own images |
| Property-based fuzz | `fuzz.test.ts` | nothing; uses `fast-check` |
| Permission matrix | `permission-matrix.test.ts` | nothing; walks the real router |
| Browser e2e | `apps/web/e2e/*.pw.ts` | Playwright + the compiled binary + Chrome |

## The browser end-to-end tests

`apps/web/e2e` drives a real browser (Playwright) against the **compiled binary**, not
the dev server, so there is no Vite and no HMR to tear the page down mid-assertion: the
binary embeds the SPA and serves the real dashboard and API together, which is what a
user gets. They cover the flows that must never break and need no Docker (onboarding,
sign-in, the viewer role boundary); deploy and database flows are proven by the
integration suite and the VPS smoke walk instead.

```sh
bun run scripts/build.ts --target=darwin-arm64 --out=dist-bin/derailed-e2e  # build first
cd apps/web && bun run test:e2e                                             # then run
```

They use the system Google Chrome (`channel: 'chrome'`) rather than a downloaded
Playwright browser, and Playwright launches the binary itself on a scratch data dir. Not
part of `bun test`; run them on demand, or after a change to the login/onboarding flow.

## The permission matrix

`permission-matrix.test.ts` enumerates every mounted route, crosses it with every
role, and compares the whole grid against `permission-matrix.expected.txt`, which is
checked into the repo. **Add or change a route and the test fails until you write down,
on purpose, what a member and a viewer may do with it.** That is deliberate: every
role-escalation this project has shipped was a route nobody had written a decision for.
To update the table after an intended change, run the suite, read what it says is
missing or stale, and edit the file to match, thinking about each line as you add it.

## The coverage ratchet

CI runs `bun test --coverage` and enforces a floor set in `bunfig.toml`
(`[test].coverageThreshold`). The rule is simple and one-directional:

- The floor is a number the suite has *already* proven it can clear.
- If coverage drops below it, CI fails. Adding code without testing it is what usually
  does this.
- When coverage climbs and stays up, raise the floor to the new level in the same PR.
  **Never lower it.** A ratchet that slips is just a suggestion.

The point is not the percentage. It is that the number can only go one way, so the
untested surface can only shrink.

## House rules learned the hard way

- **Prefer a real container to a mock.** Nearly every genuine bug found in this
  codebase surfaced through an integration test or by driving a running server as a
  non-owner, and would not have shown up against a mock. The BusyBox `realpath` break
  that quietly disabled the file browser on every Alpine image is the latest: it passed
  every unit test and failed the moment a real `alpine` container ran the code.
- **Fuzz the boundaries, do not hand-write five hundred near-identical cases.** A
  property test covers them in one, and states the invariant while it is at it.
- **Check a new regression test against the unfixed code before believing it.** A test
  that passes before the fix is not testing the fix.
- **No flaky tests.** A test that fails one run in ten is worse than no test: it trains
  everyone to ignore red. Quarantine and fix it the day it appears.
