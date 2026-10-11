# 25. Emergency compaction when the model has no context window

- Status: Accepted
- Date: 2026-10-10

> **Amended (0.3.2).** The `agent_settled` handler now awaits the compaction, resolving on
> `onComplete` or `onError`, instead of starting it and returning. pi resolves `prompt()`
> and `waitForIdle()` only after `agent_settled` handlers return, so the session stays busy
> until the compaction is done: print mode cannot exit and the next prompt cannot start
> while it runs. There is no deadlock, because `compact()` waits for idle and the run is
> already inactive when `agent_settled` fires. The pending flag stays as a guard.

## Context

[ADR 0023](0023-overflow-compaction-escape-hatch.md) made `session_before_compact`
cancel routine threshold compaction because FIFO owns context. But FIFO only operates
when the `context` hook gets a usage report with a valid (>0) `contextWindow`, and pi's
`getContextUsage()` returns nothing at all for a model whose metadata has no
`contextWindow`. For such a model FIFO never runs, and since the fork defaults
`compaction.enabled` to `false`, nothing manages context.

Two fallbacks were rejected:

- **Letting threshold compaction through `session_before_compact` until FIFO sees a
  window.** With compaction disabled (the default) pi never starts threshold compaction,
  so the hook never fires and the fallback is dead code. With it enabled it is far too
  aggressive: with a window of 0, `shouldCompact(tokens, 0)` is `tokens > -reserveTokens`,
  always true, so pi compacts after essentially every run once history exceeds
  `keepRecentTokens` (~20k tokens).
- **Firing from the `context` hook or `agent_end`.** `ctx.compact()` immediately
  disconnects the session from agent events and aborts the run. From `context` that kills
  the pending LLM call, and manual compaction never retries the turn. Extension
  `agent_end` handlers run inside the agent loop, *before* pi handles retry and
  overflow/threshold compaction: a retryable error on that run would be retried while the
  session is disconnected (its messages never persisted), and an overflow compaction would
  race the forced one ("Already compacted").

Pi's own overflow recovery (ADR 0023) still works without a window for provider errors it
recognizes as overflow; it cannot catch silent truncation, which needs the window.

## Decision

`session_before_compact` keeps the ADR 0023 rules unconditionally: cancel `threshold` and
reason-less compaction, allow `overflow` and `manual`. There is no hook fallback.

The only fallback is an **emergency compaction at `agent_settled`**:

- `agent_settled` fires once per run, after all retries, overflow recovery, threshold
  handling and queued continuations, with the run already inactive. `ctx.compact()`'s
  abort and `waitForIdle()` then have nothing in flight: no turn is lost and nothing runs
  disconnected.
- Each settled run whose last `context` call had no valid window increments a counter; a
  context call with a valid window resets it. The state tracks the **current** model, not
  the session: pi only reports no window when the current model's metadata lacks one, so
  a missing window is never transient. Switching from a windowed model to a window-less
  one stops FIFO and starts the count; switching back resumes FIFO and clears it.
- At `emergencyCompactionRuns` runs (default 15; settings key or
  `PENPI_EMERGENCY_COMPACTION_RUNS`) PENpi calls `ctx.compact()`. It ignores
  `compaction.enabled` and reports reason `manual`, which the hook allows.
- **Size gate:** `ctx.compact()` aborts and announces the compaction before pi discovers
  there is nothing to summarize. PENpi first applies pi's own rule (exported `findCutPoint`
  over the session branch, mirroring the unexported `prepareCompaction`) with pi's
  configured `compaction.keepRecentTokens`, read through pi's exported `SettingsManager`
  from global settings only — never project settings, which may be untrusted (falling back
  to pi's default if the settings cannot be read). If nothing would be
  summarized it defers, keeping the count, and re-checks on the next run.
- **Guard:** a pending flag prevents concurrent `ctx.compact()` calls (pi has no guard). It
  clears on completion, on error, and if `ctx.compact()` throws synchronously; the counter
  also resets in all three cases, so a compaction that keeps failing cannot fire on every
  run.
- **Reporting:** `ctx.ui.notify` (when there is a UI), never `console.error`, which corrupts
  the TUI. A warning when the compaction starts; an error for unexpected failures, and once
  per session if `ctx.compact()` throws. For "Nothing to compact", "Already compacted" and a
  user cancel PENpi adds no notification of its own — but pi itself still shows a failed
  manual compaction in the UI ("Compaction failed: …"; a cancel shows as aborted).

## Consequences

- A session where FIFO cannot run degrades to pi's summarizing compaction instead of
  growing until it hard-fails. This is a second bounded exception to "never summarize",
  only for a model with no context window; normal sessions keep compaction off and FIFO in
  charge.
- With the window permanently missing, compaction recurs about every
  `emergencyCompactionRuns` runs once there is enough history. The run count is a
  minimum, not an exact trigger: the size gate defers until the session branch clears
  `keepRecentTokens`, so a terse model producing short responses may take additional runs
  beyond the threshold before the first compaction fires. PENpi cannot measure actual
  size, so the run count is the proxy.
- A single very long run can grow past the window before it settles; genuine overflow errors
  inside it are still caught by pi's overflow recovery (ADR 0023).
- The size gate follows pi's global settings file, not project settings or in-memory
  overrides (an SDK caller that builds its own `SettingsManager`): a trusted project that
  sets `compaction.keepRecentTokens` can make the gate disagree with pi, and pi then shows
  "Compaction failed: Nothing to compact" for that attempt; the count resets and the next
  attempt is a full `emergencyCompactionRuns` later.
- The ordering guarantee is tested in pi's real `AgentSession`
  (`packages/coding-agent/test/penpi-emergency-compaction.test.ts`): a retry on the
  threshold run is persisted before the single forced compaction, and a switch to a
  window-less model arms the fallback.
