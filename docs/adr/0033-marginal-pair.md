# 33. A marginal sample and an evidence sample detect silent truncation together

- Status: Accepted
- Date: 2026-11-07

## Context

The context engine detects silent truncation from the input usage a provider reports (ADR 0032, behaviour E3.5).
Between two consecutive requests whose message list only grew, the reported usage must grow by about the expected
tokens of the appended text. The growth ratio of a judged sample (reported growth over expected growth) falls in one
of three bands:

- **Evidence:** below `silentShortfall` (0.25). Strong evidence (no growth, or below 0.15 of an append of 1,000
  tokens or more) acts at once; otherwise two evidence samples within `silentEvidenceSpan` (30 samples) act.
- **Marginal:** below `silentMarginal` (0.5). It is no evidence, and it cannot clear evidence.
- **Clean:** anything else. A clean sample above everything reported so far, by more than `plateauFlatness`, clears
  the evidence.

E2 on the upstream v1.5.0 corpus (`f9a263655`, PENpi 0.7.0) has two runs that fail C6, the detection lag (at most 3
truncated requests before detection):

- **`research.glm.32k.silent-messages`, lag 4.** Call 11 is truncated, with growth about 0.40 (marginal). Call 18 is
  evidence (0.18). Call 22 is truncated as well, but it reports a new maximum (16,218, under the server's limit of
  16,384) at growth about 0.73, so it clears the evidence. Call 27 is strong and detects alone, at call 28. Pi
  1.5.0's system prompt, 104 tokens shorter than 1.4.0's, makes call 22 a truncated call. On Pi 1.4.0 it was 4
  tokens under the limit, and the run passed at lag 3.
- **`data.o200k.1m.silent-messages`, lag 4** (a known failure since 0.6.0). Calls 30 and 31 are marginal (0.35 and
  0.48), call 48 is evidence and call 49 strong: detection at call 50.

In both runs the first truncated calls are marginal and the evidence comes within the span, but a marginal sample
counts for nothing.

### Not adopted: the growth check's margin calibrated per model

A first 0.8.0 change calibrated the growth check's margin: from 20 measured growth ratios on, the evidence threshold
was the lowest of them less 0.3. It cleared the data run (lag 2). It also turned honest content into evidence. A
replay of 720 bench sessions, real tool output, through the detector on an honest server gave:

- 49 false evidence samples, where the fixed margins gave 1 (from the exact-repeat rule);
- 25 false detections in 180 sessions once each `+`-bar output (`git diff --stat`, `git log --stat`) was repeated,
  where the fixed margins gave none.

The estimator counts those `+` bars at about twice their real tokens: they read 0.49 to 0.55 of the estimate, far
below the other content kinds. That change is not adopted; its commit stays on its own branch.

### Not adopted: a short clean sample does not clear evidence

If call 22 kept the evidence, call 27 would still detect alone at call 28 (lag 4), and clearing is what forgets false
evidence.

## Decision

A marginal sample and an evidence sample within the evidence span count as two suspects, in either order
(`silentMarginalPair`, on; an internal option for tests, not a setting):

- **A marginal sample first:** it is kept with its sample count, and not quarantined, since nothing marks it when it
  is judged. When a lone evidence sample (not strong: that one acts alone) follows within the span, the marginal
  samples join it and detection follows. Detection then restores the ratio from before the first of them, and names
  their answers, as for any evidence.
- **Evidence first:** a marginal sample within the span is the second suspect. It is quarantined, like evidence, and
  detection follows.
- **Two marginal samples never detect.** Honest content can read marginal: the `+`-bar outputs read about 0.5, and
  twice in a row is ordinary (`git log --stat` after `git diff --stat`).
- **What forgets a marginal sample:**
  - a clean sample above everything reported so far, marginal samples included, by more than `plateauFlatness`, as
    for evidence;
  - the evidence span (30 samples);
  - a detection;
  - `/penpi reset-limits`.

  A provider switch parks them with the evidence (D24). They are not persisted, like the evidence.
- **The learned window is unchanged:** the largest usage ever reported. A marginal sample's report is part of it,
  and it cannot exceed what the server processed.

Only marginal samples by growth count: the sample after a length stop and an unjudged sample at a provider switch
are marginal too (they cannot clear evidence), but they never join a pair.

## Results

E2 on the v1.5.0 corpus (`f9a263655`), with 0.7.0's engine plus this rule, on the fixed margins:

- `research.glm.32k.silent-messages`: truncated at 11 and 18, detected at 19, lag 2 (was 4);
- `data.o200k.1m.silent-messages`: truncated at 30, 31 and 48, detected at 49, lag 3 (was 4);
- the other 32k silent runs keep their truncated calls, detections and lags;
- no false detection.

The full E2 and the replay of bench sessions are in the 0.8.0 gate. Both known-failure entries are removed.

## Consequences

- **The residual risk is one honest marginal sample and one honest evidence sample within 30 samples.** In the
  replay, honest marginal samples were rare (8 in 720 sessions, all `+`-bar outputs at 32k), and the one honest
  evidence sample had none near it. Such a false detection learns a window from the largest usage reported, for that
  session only. A window below a quarter of the planning window is re-probed, and `/penpi reset-limits` clears it.
- **Detection with marginal samples first restores the ratio from before them.** The marginal samples entered the
  calibration ratio when judged, like any clean sample.
- **Tests:** `v080-marginal-pair.test.ts` (each order detects; two marginal samples do not; a clean sample above the
  maximum in between forgets the marginal one; the rule off detects nothing) and the detector's unit tests
  (`completesMarginalPair`, `clearsMarginals`).
