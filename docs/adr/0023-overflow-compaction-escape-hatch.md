# 23. Overflow compaction is an escape hatch, not a contradiction

- Status: Accepted
- Date: 2026-08-06

## Context

[ADR 0003](0003-fifo-replaces-compaction.md) disabled compaction. An external review
found this also disabled pi's **overflow recovery**: `_checkCompaction` returned
`false` for every reason when `compaction.enabled` was false. FIFO prunes at unit
granularity and keeps the newest atomic unit (assistant + its tool results)
unconditionally, so a single oversized unit (e.g. many parallel tool calls, or an
untruncated MCP result) can exceed the window on its own. FIFO cannot shrink it, and
with recovery dead the turn hard-fails with no escape.

## Decision

Treat `compaction.enabled` as governing **routine threshold compaction only**. The
fork guard in `_checkCompaction` moves below the overflow case, so overflow recovery
runs regardless of the setting. The `session_before_compact` hook becomes
reason-aware: `threshold` is cancelled (FIFO owns routine context management);
`overflow` passes through (one emergency summary beats a dead session); `manual`
passes through (an explicit `/compact` is user intent). An absent reason cancels.

## Consequences

- The "never summarize" guarantee gains one bounded exception: genuine overflow of a
  single atomic unit, which FIFO can never resolve. This is rare (built-in tools
  truncate at 50KB) and self-announcing (pi emits compaction events).
- The fork edit in `settings-manager.ts` keeps `enabled=false` as the default, so no
  threshold compaction noise appears; the hook is the authoritative veto.
