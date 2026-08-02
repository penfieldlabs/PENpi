# 19. Disable the upstream-pi update banner

- Status: Accepted
- Date: 2026-06-26

## Context

Pi's interactive mode checks pi.dev for a newer pi release and shows an "Update Available —
run `pi update`" banner. PENpi is a **fork** pinned to a specific pi base; `pi update` is
built to replace an npm-installed pi with the official release, which would overwrite or
conflict with the fork. The banner therefore steers PENpi users toward breaking their
install, and advertises a product (stock pi) that isn't what they're running.

## Decision

Disable the upstream-pi version banner — remove the `checkForNewPiVersion` call in
`interactive-mode.ts run()` (the only caller). This is a deliberate, minimal core change.

- The **package**-update check (our pinned MCP packages: adapter, DuckDuckGo) is kept — it
  concerns PENpi's own dependencies, which we update consciously.
- A **PENpi-native** self-update banner (check our releases, run a PENpi updater) is a
  roadmap item — it needs release infrastructure we don't have yet (tags, a release feed,
  an updater). Until then, adopting a newer pi base is a deliberate upstream rebase, not a
  one-button update.

## Consequences

- Users are no longer nagged to install stock pi over the fork.
- One small, documented core change (the only behavioral edit to pi-core besides the
  compaction default, [ADR 0003]).
- Revisit when PENpi cuts releases — then repurpose the banner to PENpi's own updates.
