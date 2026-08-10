# Contributing

Issues and pull requests are welcome.

## Running it locally

Requires [Bun](https://bun.sh) and, for anything that touches containers, Docker.

```sh
bun install
bun run dev        # dashboard on :5173, API on :1337
```

Development mode keeps state in `./.dev-data` and puts Caddy on ports 8080 and 8443, so
nothing needs root and nothing collides with a real installation.

```sh
bun test           # unit and integration
bun run typecheck
bun run lint       # biome, also formats
bun run build      # one binary for this machine
bun run build --target=linux-x64
```

The integration tests skip themselves without a Docker socket, so a green run on a
machine without Docker proves less than it looks. Run them with Docker before opening a
pull request that touches the runtime.

## Layout

See [architecture](architecture.md) for what lives where and why. In short: the server
is `apps/server/src`, the dashboard is `apps/web/src`, and anything both sides agree on
is in `packages/shared`.

## Conventions

**Comments explain why.** Not what the line does; the line does that. If something is
written in a surprising way, the comment says what went wrong when it was written the
obvious way. Several comments in this codebase are incident reports, and they are the
most valuable ones.

**Errors are written for a person.** Not "ECONNREFUSED", but what happened and what to
do next. `FriendlyError` carries a message, an optional hint and optional detail; the
HTTP layer passes all three through, and the dashboard shows them.

**Plain language in the interface.** No "ingress", no "SIGTERM", no "orchestration".
Someone who has never opened a terminal should be able to read every screen. When a
technical term is unavoidable, explain it in the same sentence.

**No silent failure.** If something is skipped, say so. A backup that quietly copies
nothing is worse than one that fails.

**Test the things that broke.** New tests are welcome anywhere, but the ones that earn
their keep describe a real incident: a restore that emptied a folder, a stats sample
that was null, a status breakdown that added up to more than the whole.

## Style

Biome handles formatting and linting; run `bun run lint` before pushing. TypeScript
strict mode is on and there are no `any` escapes in the codebase. Please keep it that
way.

### No em dashes

Not a preference, a rule, and `bun run lint` fails on one. No em dashes and no en
dashes, in code, comments, documentation or interface copy.

```
apps/server/src/thing.ts:42  em dash
  // the offending line is printed here, with the character in it
  use a comma, a colon, a full stop, or brackets instead
```

They are the tell of copy that was pasted in or generated, they render at different
widths depending on the font, and they are awkward to type on most keyboards. Every
sentence that wanted one reads at least as well with a comma, a colon, a full stop, or
a pair of brackets. Usually better, because the rewrite forces you to decide what the
aside was actually for.

If you hit it, `bun run check:style` prints every line and what to use instead.

Commit messages describe the change and, where it matters, the reasoning. The history
is the changelog until the first release.

## Things worth doing

The code is honest about its gaps. Searching for what is missing:

- Deploying on push (a GitHub webhook exists in outline, not in practice).
- `docker-compose` repositories: detected and warned about, not run.
- More than one machine. This is deliberately a single-server tool for now.
- More ready-made apps. Each is a small, well-defined addition to
  `apps/server/src/catalog/templates.ts`; only add ones you have actually run.
