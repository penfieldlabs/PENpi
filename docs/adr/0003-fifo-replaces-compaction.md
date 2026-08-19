# 3. Replace compaction with FIFO context management

- Status: Accepted
- Date: 2026-06-21

## Context

Pi (like most agents) handles a full context window by **compaction**: an LLM summarizes
the oldest messages. Summarization destroys detail irreversibly and is lossy in ways
that are hard to predict. We want a context strategy that never silently rewrites
history, and that also controls cost and quality on models that degrade past ~70–80%
context utilization.

## Decision

Replace compaction with **FIFO watermark pruning** in the `context` hook: when usage
exceeds a ceiling (default 0.75 of the window), drop the oldest non-protected messages
down to a floor (default 0.50). PENpi injections are protected; the newest message is
always kept; order is preserved. Nothing lost to summarization — dropped messages remain
in the transcript ([0004](0004-three-tier-memory.md)). Compaction is **off by default**
(fork core default `getCompactionEnabled()=false` + shipped `settings.json` +
`session_before_compact` returns `{cancel:true}` as belt-and-suspenders).

> **Amended by [ADR 0023](0023-overflow-compaction-escape-hatch.md) (0.2.0).** The decision
> above stands for routine context management: threshold compaction is still cancelled and
> FIFO still owns the normal path. Two details are no longer accurate as written. The hook
> is now reason-aware rather than an unconditional `{cancel:true}` — it cancels `threshold`
> and a missing reason, and allows `overflow` and `manual`. And "nothing lost to
> summarization" holds only for routine roll-off: FIFO prunes whole atomic units and always
> keeps the newest, so a single unit too large for the window cannot be shrunk by pruning,
> and 0.2.0 lets emergency overflow recovery summarize it rather than hard-fail the turn.

## Consequences

- No lossy summaries on the routine path (see the amendment above for the overflow
  exception); a sawtooth utilization curve (floor↔ceiling) instead of riding at ~100%.
- Recall of dropped content depends on Tier 2 (Penfield) and Tier 3 (transcript search).
- Pruning strategy is intentionally simple; token estimation and smarter eviction
  (drop tool results first, etc.) are flagged for benchmarking before optimizing.
