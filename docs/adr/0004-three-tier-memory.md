# 4. Three-tier memory model

- Status: Accepted
- Date: 2026-06-21

## Context

With compaction removed ([0003](0003-fifo-replaces-compaction.md)), we need an explicit
story for where information lives and how the agent retrieves it.

## Decision

Three tiers, each with a clear role:

- **Tier 1 — context window (FIFO):** recent messages, the working surface. Oldest roll off.
- **Tier 2 — Penfield:** curated, persistent memory the agent uses **deliberately**
  (recall/store/connect/reflect/…). Survives across sessions. High signal.
- **Tier 3 — session transcript:** Pi's verbatim JSONL logs. The searchable safety net
  for anything that rolled out of Tier 1 and was not stored to Tier 2
  (see [0012](0012-transcript-search-tier-3.md)).

PENpi does not auto-store to Penfield; the agent stores consciously. The transcript
catches everything else.

## Consequences

- Nothing important is lost: it is in Tier 2 or recoverable from Tier 3.
  **Amended by [ADR 0023](0023-overflow-compaction-escape-hatch.md) (0.2.0).** That
  holds for routine FIFO roll-off, which is what this ADR decided: durable facts belong
  in Tier 2 and rolled-off messages stay verbatim in Tier 3. It is no longer absolute.
  FIFO prunes whole atomic units and always keeps the newest one, so a single unit can
  exceed the window on its own; 0.2.0 lets emergency overflow recovery summarize that
  unit rather than hard-fail the session. Bounded, self-announcing, and never routine.
- Each tier needs a real retrieval path — Tier 3 in particular requires a search tool,
  or the promise is hollow (this gap was the motivation for ADR 0012).
