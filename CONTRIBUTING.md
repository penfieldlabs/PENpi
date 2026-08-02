# Contributing to PENpi

PENpi is a fork of [Pi](README.md) (MIT). This guide is how we keep it clean and how it
stays reviewable under outside scrutiny. For Pi-core (`packages/**`) conventions, see
[AGENTS.pi.md](AGENTS.pi.md). For working rules, see [AGENTS.md](AGENTS.md).

## Principle

Exemplary, professional standards regardless of pace. Every decision is an ADR; every
code path is type-checked, linted, and tested **in CI** — not by hand.

## Before you commit

Install Node.js 22.19+, npm, Git, `ripgrep` (`rg`), and `fd` 8.7.0+. On Debian/Ubuntu the
`fd-find` package exposes `fdfind`; provide an `fd` symlink on `PATH` for the gate. Debian
stable may ship `fd` 8.6.0, so verify with `fd --version` and upgrade if needed. Keep the
absolute checkout path short; the suite has known path-length sensitivity documented in
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

1. `npm run check` — biome + type-check (incl. `check:penpi` for the extension) +
   supply-chain checks.
2. `npm test` — all workspace tests, including the PENpi extension suite (`npm test -w penpi`).
3. If you made an architectural/behavioral decision, add or update an ADR in
   [`docs/adr/`](docs/adr/) (see [ADR 0001](docs/adr/0001-record-architecture-decisions.md)).
4. If you touched a live path (auth, hooks, MCP tools), verify it per
   [docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md).

Husky runs the gate on commit; CI runs the same on push/PR.

## Branches & commits

- Branch off `main`: `feat/…`, `fix/…`, `chore/…`, `docs/…`. One logical change per branch.
- Merge only when green (and the ADR/tests above are in place).
- Regression tests for fixed bugs are named by issue number, e.g. `…_gh128`.

## Dependencies

- Exact-pin every external dependency ([ADR 0014](docs/adr/0014-pin-third-party-dependencies.md));
  bump deliberately and re-run the gate.

## Where things live

- Extension code: `.pi/extensions/penpi/`
- Configuration: `settings.json` `penpi` key → env vars → flags ([ADR 0015](docs/adr/0015-layered-configuration.md));
  reference table in the [extension README](.pi/extensions/penpi/README.md).
- Decisions: `docs/adr/` · Architecture: `docs/ARCHITECTURE.md` · Test protocol: `docs/TEST_PROTOCOL.md`

## Testing strategy

- **Pure logic** (FIFO planner, config precedence, MCP config, token manager, transcript
  search): vitest unit tests against fixtures — never real sessions or live network.
- **Hooks/orchestration**: tested hermetically via dependency injection — `penpiCore(pi, deps)`
  with a fake `pi` and a stub client (`index.test.ts`) drives automatic orientation,
  `context` (FIFO), `session_before_compact`, and `session_shutdown`.
- **Live paths** (Penfield device login, GLM end-to-end, web search, transcript search,
  the persistence loop): verified manually per the test protocol, since they require
  external services. Keep these hermetic where possible; document where not.

## Release review

Before a public release or material Pi-core rebase, freeze an exact candidate commit and
hand it to an independent reviewer together with [`docs/TEST_PROTOCOL.md`](docs/TEST_PROTOCOL.md).
Resolve release blockers, record accepted non-blockers in
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md), and rerun the complete automated
and live gates before publishing. Keep private review prompts, frozen model reports, test
credentials, and canaries outside the distributed repository.
