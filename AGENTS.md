# AGENTS.md — PENpi

Rules for everyone working on PENpi (humans and agents). PENpi is a fork of
[Pi](README.md). Pi's development rules are retained in [AGENTS.pi.md](AGENTS.pi.md),
with upstream-only repository process removed, and still apply to the Pi core (`packages/**`).

## What PENpi is
A Pi extension (`.pi/extensions/penpi/`) plus a few fork-level defaults. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the decision records in
[docs/adr/](docs/adr/).

## Hard rules
- **Decisions get ADRs.** Any architectural/behavioral decision is recorded in
  `docs/adr/` (see [ADR 0001](docs/adr/0001-record-architecture-decisions.md)). No silent decisions.
- **The gate is law.** `npm run check` and `npm test` must pass before every commit
  (husky enforces; CI re-runs). The extension is covered by `npm run check:penpi` (tsc)
  and biome.
- **Erasable TypeScript only** in checked code: no parameter properties, `enum`,
  `namespace`, `import =`. Use explicit fields + constructor assignment.
- **Pin external deps exactly; bump consciously** ([ADR 0014](docs/adr/0014-pin-third-party-dependencies.md)).
- **Follow the spec/docs; discover, don't hardcode** ([ADR 0008](docs/adr/0008-oauth-endpoint-discovery.md)).
  Read docs.penfield.app before making Penfield claims.
- **Secrets never enter git.** Tokens/keys live outside the repo (mode 600).
- **Never wipe or mutate users' session logs or working directories** during dev/testing.
  Transcript access is read-only.
- **Code quality:** no `any` unless necessary; read files fully before wide edits; ask
  before removing intentional code; match surrounding style (tabs, width 120).
- **Credit Pi.** Preserve `LICENSE`, `README.pi.md`, and clear upstream attribution.

## Workflow
- Branch off `main`; one logical change per branch; merge only when the gate + tests are
  green and (if applicable) an ADR is added.
- Verify live paths (auth, hooks, tools) per [docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md).
- Name regression tests by issue: `*_gh<N>`.
