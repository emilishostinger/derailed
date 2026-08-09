# Testing

The bar here is not a test count, it is whether a test would *fail* if the thing it
guards broke. A suite that runs a lot of lines and asserts nothing is decoration. So
the shape of this is: fuzz the boundaries, example-test the behaviour, and prove the
whole thing green somewhere that actually has Docker.

## Running it

```sh
bun test                      # the whole suite, from the repo root (the preload needs it)
bun test ./apps/server/test/net.test.ts   # one file
bun test --coverage           # with the coverage report
```

Two things worth knowing:

- **Run it from the repo root.** `bunfig.toml` preloads `apps/server/test/setup.ts`,
  which gives every run its own throwaway data directory (so nothing touches
  `/var/lib/derailed` or your `.dev-data`) and its own Caddy name, network and ports.
  Run it from a subdirectory and the preload does not fire.
- **The integration tests skip themselves without Docker.** Files ending
  `.integration.test.ts` check for a Docker socket and turn into no-ops when it is not
  there. That is why a green run on a laptop without Docker proves less than it looks:
  the container-touching half simply did not run. CI has Docker, so there it does.

## What runs where

| Kind | Marker | Needs |
|---|---|---|
| Unit / property | plain `.test.ts` | nothing but Bun |
| Integration | `.integration.test.ts` | a Docker socket; pulls its own images |
| Property-based fuzz | `fuzz.test.ts` | nothing; uses `fast-check` |
| Permission matrix | `permission-matrix.test.ts` | nothing; walks the real router |

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
