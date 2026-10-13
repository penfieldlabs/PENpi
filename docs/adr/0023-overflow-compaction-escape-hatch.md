# 23. Overflow compaction is an escape hatch, not a contradiction

- Status: Accepted
- Date: 2026-08-06

> **Amended (0.4.1).** Moving the guard also let the recoverable length stop through:
> a `length` stop whose output is below the model's `maxTokens`. That is not overflow,
> but pi recovered it by compacting, which hid a reply the user could still read and
> summarized the conversation with compaction disabled. It now runs only when
> `compaction.enabled` is true; with compaction disabled the reply stays visible and
> PENpi's length continuation ([ADR 0028](0028-length-continuation.md)) asks the model
> to carry on. Context overflow still recovers regardless of the setting, in all three
> forms: an explicit provider error, a completed response whose usage exceeds the window
> (z.ai style, including the z.ai models PENpi's README recommends), and a zero-output
> `length` stop whose input fills the window (the provider truncated the input).

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
runs regardless of the setting (a length stop below `maxTokens` is not overflow; see the
0.4.1 amendment). The `session_before_compact` hook becomes reason-aware: `threshold` is
cancelled (FIFO owns routine context management);
`overflow` passes through (one emergency summary beats a dead session); `manual`
passes through (an explicit `/compact` is user intent). An absent reason cancels.

## Consequences

- The "never summarize" guarantee gains one bounded exception: genuine overflow of a
  single atomic unit, which FIFO can never resolve. This is rare (built-in tools
  truncate at 50KB) and self-announcing (pi emits compaction events).
- The fork edit in `settings-manager.ts` keeps `enabled=false` as the default, so no
  threshold compaction noise appears; the hook is the authoritative veto.
