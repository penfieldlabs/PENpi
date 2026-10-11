# 27. The FIFO prune budget is floor × window, with no learned calibration

- Status: Accepted
- Date: 2026-10-11

## Context

FIFO estimates tokens with Pi's chars/4 heuristic. Dense content (code, CJK, base64)
costs more real tokens than that, by a factor PENpi learns from provider reports as a
calibration slope (0.2.0, the generalization of F3). The slope fed two places: the
trigger, deciding whether the candidate list crosses the ceiling, and the prune budget,
deciding how much history is kept.

The budget path was wrong whenever the slope was above 1. `planFifo` took the gap
between the trigger total and the raw message estimate and charged it as fixed overhead
(capped at a fraction of the window), modelling any excess as a calibration ratio. But
the hook is call-scoped: the full history keeps growing while only the sent window is
pruned, so at slope `s` the gap includes `(s - 1) × full history`. That growth was
charged as unevictable overhead, the cap filled, the ratio grew with the history, and the
budget shrank on every call. In a simulated 80-turn session (100k window, 5k overhead,
floor 0.5 / ceiling 0.75), the window settled at 52% at slope 1 but at 14-19% at slopes
1.5-3. Every existing test reported at slope 1, which hid it.

## Decision

- **The budget is policy only:** `floor × contextWindow` of estimated message tokens.
  No learned slope, learned offset, or reported total enters it.
- **Calibration stays for estimation.** The trigger still estimates the candidate list's
  real size as `slope × estimate + offset` and compares the greater of that and a
  credible provider report against the ceiling. Without it, at slope 2 a history
  estimated at 45% of the window is really over 90% and would never be pruned.
- **New defaults: floor 0.2, ceiling 0.8**, still user-configurable. The undercount is
  absorbed by the gap between them: a pruned context really costs about
  `slope × floor × window + overhead`, which fits a 4x undercount at the defaults.
- The floor-aware overhead cap (`MAX_OVERHEAD_FLOOR_FRACTION`) is removed. It existed
  only to stop a learned overhead from zeroing the budget, which can no longer happen. The
  learned offset is still capped at half the window inside the trigger estimate.

## Consequences

- At any slope a session settles at the floor in estimated tokens, so the kept history no
  longer depends on what the estimator learned or on how long the session has run.
- For ordinary prose (slope about 1) the window now settles at about 20% plus overhead,
  down from about 52% at the old 0.5 floor. Pruning is per call, so once over the
  ceiling every call prunes back to the floor: use sits at the floor, not between floor
  and ceiling. Users who mostly write prose can raise the floor.
- The window is only guaranteed to fit while `slope × floor × window + overhead <=
  window`. Outside that envelope (a 4x undercount with a floor above 0.2, or overhead
  above about 20% of a small window), a pruned context can exceed the window; the
  provider's error then goes to pi's overflow recovery (ADR 0023). The previous budget
  converged inside the window even there, at the cost of the collapse above. Property P5
  asserts the envelope. Because existing settings may still carry the old 0.5 floor,
  PENpi warns once per load at `session_start` when `contextFloor` is above 0.25, the
  most a 4x undercount leaves room for.
- A report that blames fixed overhead for crossing the ceiling no longer shreds a
  conversation that already fits the floor: there is nothing worth evicting, and
  evicting messages cannot shrink overhead.
