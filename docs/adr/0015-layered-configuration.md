# 15. Layered configuration precedence

- Status: Accepted
- Date: 2026-06-21

## Context

PENpi has several knobs (Penfield env/auth, FIFO ceiling/floor, save-on-shutdown, MCP
lifecycle). Configuration must be predictable, support per-session overrides for
testing, and ship sane defaults.

## Decision

One precedence order, highest first: **CLI flag → environment variable → `penpi` key in
pi's `settings.json` (project then global) → built-in default**. Resolvers live in
`config.ts` (`resolvePenpiConfig`, `resolvePenfieldConfig`, `resolveMcpLifecycle`).
Defaults are production-safe (compaction off, save-on-shutdown off, ceiling 0.75 /
floor 0.50, floor forced below ceiling and clamped).

## Consequences

- Predictable behavior; easy per-session overrides (env/flag) without editing files.
- Settings are documented in one place ([extension README](../../.pi/extensions/penpi/README.md)).
