# 10. save_context on shutdown is opt-in (default off)

- Status: Accepted
- Date: 2026-06-21

## Context

`session_shutdown` can checkpoint the session to Penfield via `save_context`. Initially
this defaulted on. In practice, rapid start/quit cycles (especially during testing)
polluted the Penfield knowledge graph with many `PENpi auto-checkpoint (quit)` contexts,
and "write a checkpoint on every exit" is surprising as a default.

## Decision

`saveContextOnShutdown` defaults to **off (opt-in)**. Enable per-session with
`PENPI_SAVE_CONTEXT_ON_SHUTDOWN=true` (or `1`) or `penpi.saveContextOnShutdown: true` in
settings. When enabled, the checkpoint is skipped on hot-reload (which immediately
re-runs `session_start`) and only fires for real exits.

## Consequences

- Clean memory graph by default; deliberate, low-noise checkpoints when wanted.
- Aligns with PENpi's "store consciously, don't auto-store" principle ([0004](0004-three-tier-memory.md)).
