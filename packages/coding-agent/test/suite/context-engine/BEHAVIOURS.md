# Context engine: behaviours, configuration and proof

This file lists every behaviour of the context engine (`.pi/extensions/penpi/engine/`) and the test that
proves it. The design is in `docs/CONTEXT_ENGINE.md` and `docs/adr/0032-context-engine.md`. The IDs (E1.1,
H3, G1, D14, ...) are stable. Code comments and test headers refer to them.

Each row gives:

- the module that implements the behaviour;
- the options it reads, with their defaults from `DEFAULTS` in `options.ts`;
- the test that proves it, as `file :: test title`, or just the file. Tests are in this folder unless the
  row says otherwise. `<x>` stands for the part of a title that a loop fills in.

The engine has one mode, `"a"` (a persistent window). The tests that loop over modes run mode a only.

**Options and settings.** Options are `EngineOptions` (`options.ts`). PENpi reads most of them from the
`penpi` block of the global settings, under the same names (`settings.ts`). These are not settings: `mode`,
`commandName`, `onCompactionEnabled`, `hiddenCustomTypes` (PENpi sets it), `faults`, `production`, `env`,
`log` and `stats`. They are options for hosts and tests.

## Modules

| Module | Responsibility |
|---|---|
| estimator | Token estimate (character classes), image tokens, overflow error parsing. |
| serializer | What Pi actually serializes per API, for the budget and the detector. |
| detector | Calibration samples, silent-truncation detection, re-probes, naming truncated answers. |
| state | Persisted session entries, per-model state, the ratio bounds. |
| limits | Window, output and ceiling resolution; learned limits; the output clamp. |
| planner | Window index, cuts, checkpoint, unit caps, images, pre-cut notice, hidden message types. |
| pin | The user-message pin, input sources. |
| header | Window header, notes and task, run records, `/tree` summaries. |
| recovery | Provider error classes, fault injection, overflow, output-limit and length recovery, compaction cancel, manual `/compact`. |
| tools/doctor | Status line, `/penpi doctor`, `/penpi reset-limits`, the P5 refusal. |
| tools/notes, tools/recall, tools/search | `context_notes`, `context_recall`, `context_search`. |
| entry, settings, telemetry | PENpi's wiring: `installPenpiEngine`, the `penpi` settings block, the opt-in log. |

## E1: Compaction is hard-off

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E1.1 | recovery | Every automatic compaction (threshold, overflow) is cancelled in `session_before_compact`. No summarization request is ever made. | none | `long-session.test.ts :: mode a: never compacts, never exceeds the window`; `recovery.test.ts :: mode a, compaction.enabled=true: injected overflow at provider call <n> is retried once` (n = 0, 12, 60) |
| E1.2 | recovery | Manual `/compact` advances the window with no model call. | `lowWater` (0.45) | `persistence.test.ts :: mode a (keepRecentTokens default): reload, resume and fork keep the cut and the calibration` |
| E1.3 | header | `/tree` with a summary gets a fixed notice. No model call. | none | same test as E1.2 |
| E1.4 | tools/doctor | The engine refuses to run while `compaction.enabled` is not false: user input is handled with an error and no model request is made. An unset setting counts as on, unless the host says compaction is off by default (`EngineWiring.compactionOffByDefault`, set by PENpi). An explicit `true` always refuses. `warn` is for tests only. | `onCompactionEnabled` ("fail") | `p5-fail-hard.test.ts :: p5 enabled: true`, `p5 setting absent (Pi default true)`, `p5 enabled: false`, `p5 setting absent, host defaults to off (PENpi)`, `p5 enabled: true, host defaults to off (PENpi)` |
| E1.5 | recovery | The engine continues a length stop before upstream's recoverable-length path. With compaction on and the continuation budget spent, upstream takes over. | `maxLengthContinuations` (3) | `length.test.ts` (6 tests, e.g. `continues a length stop below maxTokens with compaction disabled`) |

## E2: Persistent, monotone window with hysteresis

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E2.1 | planner | Cuts when the projected request exceeds `highWater` × input budget, down to `lowWater` × budget. Cuts only at a startable boundary: never between a tool call and its result, never starting with an assistant message. | `highWater` (0.75), `lowWater` (0.45) | `long-session.test.ts :: mode a: never compacts, never exceeds the window` (0 structural violations); `properties.test.ts` (validity) |
| E2.2 | planner | The request prefix is byte-stable between cuts. The prefix breaks once per cut. | none | `properties.test.ts` (prefix: exactly one break per cut); `long-session.test.ts` (breaks ≤ cuts); `h8-ceiling.test.ts :: h8 a 128k model's status shows no declared window and the prefix stays stable` |
| E2.3 | state | The cut is a custom entry `{kind:"cut", firstKeptEntryId, seq, header}`. Reload, resume and fork keep it, and window numbering continues. | none | `persistence.test.ts` |
| E2.6 | planner | An incremental window index keeps per-request cost flat as the session grows. Bar: median engine time below 1 ms per request at 20,000 turns, with the pin on. | none | `h7-scaling.test.ts :: h7 20000 turns, mode a` (opt-in); `bench.test.ts :: mode a: 2000 turns` (opt-in, reports only) |
| E2.7 | planner | With the notice on, a request-only notice shortly before a cut names what will leave view. It is never persisted, is always the last message, and the prefix still changes only at cuts. It names only active tools. | `notice` (false), `noticeFraction` (0.9) | `precut-notice.test.ts :: notice once per cut cycle, at the tail only, never persisted, prefix stable (fixture seed <n>)` |
| E2.8 | planner | One notice per cut cycle. Every cut, and every index rebuild, re-arms it. `noticeRepeats: true` gives a notice on every request in the zone. | `noticeRepeats` (false) | same test as E2.7; `precut-notice.test.ts :: G3 noticeRepeats: a notice on every request in the zone, right before each cut (fixture seed <n>)` |
| E2.10 | planner, header | The header carries a timestamp just after the cut, so Pi's `max_tokens` estimate ignores pre-cut usage. Without it, the first request after a cut asked for 3,931 on a 32k/8k model (reserve 6,553). | none | `h8-ceiling.test.ts :: h8 output reserve = min(max output, 20% of the capped window); a request may still ask for more` |
| E2.11 | planner | System messages before the cut fold into one checkpoint system message at the head of the request. Later ones stay in place. | none | `b01-system-checkpoint.test.ts :: b01 two system messages before a cut and one after: one checkpoint, the later one in place` |
| E2.12 | planner | `notice: false` (the default) sends and counts no notice. The cuts are exactly where they are with the notice on. | `notice` (false) | `precut-notice.test.ts :: notice: false sends no notice, with or without repeats, and cuts as before (fixture seed <n>)` |
| HID | planner | Custom messages of a type in `hiddenCustomTypes` stay in the session (and `context_search` finds them) but are left out of every request and of the budget. PENpi lists `penpi-briefing`, the 0.4 orientation message. | `hiddenCustomTypes` ([]) | `penpi-briefing.test.ts :: never sends or pins a resumed 0.4 session's penpi-briefing messages, which stay in the session` |

The pre-cut notice tests run on two fixture seeds (13 and 14). Entry ids are deterministic (D13), so each
seed gives the same session on every run.

## E3: Calibration and silent truncation

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E3.1 | estimator | Character-class density estimator fitted on o200k_base and GLM-5.3-Flash. Class residuals are 0.85–1.12, against 0.60–2.95 for chars/4. | none (fitted constants) | `h6-unit-density.test.ts :: h6 <cjk, base64> unit stays within its share of the budget in o200k tokens (mode a)` |
| E3.2 | detector | The ratio is learned from the request actually sent against reported usage. The first sample sets it; samples 2 and 3 weigh 0.5, later ones 0.2. `calibrate: false` pins the ratio at 1. | `calibrate` (true) | `calibration.test.ts :: mode a, calibrate=true: provider counts 1.7x the estimate`, `mode a, calibrate=false: provider counts 1.7x the estimate` |
| E3.3 | state | The ratio is clamped to [`ratioFloor`, `ratioCeiling`]. | `ratioFloor` (0.8), `ratioCeiling` (6) | `b02-ratio-clamp.test.ts :: b02 samples at 0.5x the estimate clamp the ratio to 0.8`, `b02 samples at 10x the estimate clamp the ratio to 6` |
| E3.4 | state | The ratio is kept per model. An unknown model starts at the densest known ratio. | none | `h2-per-model-calibration.test.ts :: h2 mode a: switching between a dense and a sparse model` |
| E3.5 | detector | Silent truncation is detected without a plateau. Between two consecutive requests whose message list only grew, reported usage must grow by about the appended text's expected tokens (images excluded, notices and replayed reasoning left out). **Strong** evidence: no growth after an append of at least `silentZeroGrowthFloor` tokens, or growth below `silentStrongShortfall` of an append of at least `silentStrongGrowth` tokens. One strong sample acts at once. **Weak** evidence: growth below `silentShortfall` of an append of at least `silentMinGrowth` tokens, with the request expected at 0.8 or more of the largest usage so far; or usage exactly equal to the largest ever reported, for a different request expected above it, once `silentSettledSamples` samples are in. `silentSuspects` judged suspects within `silentEvidenceSpan` samples act. Unjudged samples (small appends, the sample after a length stop, warm-up) are skipped and do not reset the count. Growth below `silentMarginal` is not evidence but cannot clear it. Only a clean sample above everything reported so far (by more than `plateauFlatness`) clears it. | `silentShortfall` (0.25), `silentMarginal` (0.5), `silentStrongShortfall` (0.15), `silentStrongGrowth` (1,000), `silentMinGrowth` (256), `silentZeroGrowthFloor` (64), `silentSuspects` (2), `silentEvidenceSpan` (30), `silentSettledSamples` (5), `plateauFlatness` (0.02) | `silent-detector.test.ts :: detects within 3 truncated requests: <scenario>, server reports <its limit, what it kept>` (3 scenarios × 2 styles); `detector-confirmation.test.ts :: one strong sample acts at once: the window is learned from it`, `two weak samples act; an unjudged sample between them does not reset the count`, `a clean sample above the running maximum between two weak samples clears the evidence: no detection`; `h1-silent-truncation.test.ts :: h1 mode a: detects the plateau and stops feeding the truncation` |
| E3.11 | detector | No detection on an honest provider, whatever the content (prose, CJK, base64, separator lines, digits, images), the counting (1.7× and 0.8×), a model switch, or 50 or more cuts. | as E3.5 | `silent-detector.test.ts :: no detection on an honest provider: density shifts, images, separator lines, a model switch, warm-up` |
| E3.12 | detector | A length stop with reasoning only is not truncation: the sample after a length stop is not judged, and replayed reasoning is not in the appended estimate. Truncation that starts after a length stop is still detected. | none | `length-stop-anomalies.test.ts :: a reasoning-only length stop is not silent truncation (honest provider, 200k window unchanged)`, `truncation that starts after a length stop is still detected within 3 truncated requests` |
| E3.9 | detector | A quarantined sample never moves the ratio or the running maximum. On detection the ratio returns to its value before the first named answer. | none | `b13-quarantine-ratio.test.ts :: b13 one strong sample: the ratio after detection is the ratio before the first named answer`, `b13 two weak samples: neither moves the ratio, and after detection it is the ratio before the first` |
| E3.10 | detector, limits | The learned window is the largest usage the provider ever reported, never above what it holds. It is kept for the session only. It is re-probed only when below `silentReprobeBelow` of the planning window, at most `silentReprobes` times per session, after `probeAfterUnparsed` clean requests at 0.3× the window or more (D12). Otherwise it is never re-probed. | `silentReprobeBelow` (0.25), `silentReprobes` (2), `probeAfterUnparsed` (8) | `silent-detector.test.ts` (window ≤ the server's limit); `detector-confirmation.test.ts :: a small false-positive window (below 25% of the planning window) is re-probed and retired by honest usage`, `a real silent truncator at 40k (20%): re-probed at most twice per session, truncated probe answers named`, `a silent-learned window at or above 25% of the planning window is never re-probed`; `length-stop-anomalies.test.ts :: a single strong anomaly mid-session on an honest provider is learned at once, then re-probed and retired` |
| E3.6 | detector | Every answer produced from truncated input is named: the quarantined samples, samples that reported exactly what a quarantined one did, samples at the maximum short of their expectation by more than `plateauFlatness`, and (D14) every recent sample expected above the learned window by more than `plateauFlatness`. Each is named (entry id, assistant turn, ISO time) in the log, a warning, and a `{kind:"plateau"}` entry. | `plateauFlatness` (0.02), `silentEvidenceSpan` (30) | `g2-plateau-report.test.ts :: g2 names the truncated turns in the log, a warning and a session entry; doctor shows them; reset clears`; `d14-truncated-answers-named.test.ts :: d14 names a truncated request whose usage grew by about its append (drop-whole-messages server)` |
| E3.7 | state | Plateau windows belong to their session. A new session starts clean. | none | `g2-plateau-report.test.ts :: g2 a plateau window is kept for its session only: a new session starts clean` |
| E3.8 | limits | The size an overflow error states raises the ratio when it is higher. A combined error's stated input part is used. | `calibrate` (true) | `calibration.test.ts :: parses limits and request sizes from provider overflow errors`; `recovery.test.ts` (injected overflows) |
| E3.13 | detector, tools/doctor | A server that reports no usage cannot be checked. Doctor says detection is unavailable. | none | `b14-no-usage-doctor.test.ts :: b14 a server that reports no usage truncates undetected; doctor shows "silent-truncation detection unavailable: no usage reported"` |

## Serializer: what Pi sends

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| B1, D4 | serializer | The budget and the detector estimate what Pi serializes per API: whether a message is sent, and whether its reasoning is sent, for every shape, blank ones included. Checked against Pi's real converters (openai-completions, anthropic-messages, bedrock-converse-stream). | `serializeAs` (none: the model's API) | `serializer.test.ts :: <model> (<api>): sent / not sent and reasoning sent / not sent agree with the converter` (one test per model) |
| B2 | serializer | The budget counts replayed reasoning; the detector's appended estimate leaves it out. | none | `serializer.test.ts :: B2: 3,000 tokens of reasoning plus 200 of text: the budget counts both, the detector's part leaves the reasoning out` |
| RR | serializer, tools/doctor | `replayedReasoning` per model: `"counted"` budgets replayed reasoning, `"ignored"` leaves it out of the budget. Thinking sent as text always counts. The detector's estimate is the same either way. Doctor names the setting when the ratio sits at the floor with thinking on. The replay check (detector, warn-only): over 20 or more consecutive no-cut request pairs whose replayed reasoning is at least 64 tokens and half the appended text, the median share of it that reported growth accounted for (uncalibrated estimates) decides whether the provider counts it; a disagreeing setting gets one warning per session and model naming the value to try, and doctor prints the pairs, median and verdict. | `replayedReasoning` ({}, every model `"counted"`) | `replayed-reasoning.test.ts :: with ignored, a 3,000-token reasoning plus 200-token text turn adds only the text; with counted, both; the detector's appended estimate is the same`, `doctor names replayedReasoning when the ratio sits at the 0.8 floor with thinking on`; `replayed-reasoning.test.ts :: replay check: warns once when ignored is set for a provider that counts, naming counted`, `replay check: warns once when counted (the default) meets a provider that ignores it, naming ignored`, `replay check: no warning when the setting matches the provider, either way` |

## E4: No unit too large

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E4.1 | planner | A tool result or user message larger than the cap keeps its head (75 %) and tail (25 %), with a `context_recall` pointer to the full entry. | `maxUnitFraction` (0.25 of the input budget) | `oversized.test.ts :: mode a: caps an oversized tool result and user message, keeps them recoverable` |
| E4.2 | planner | Caps are sized in estimated real tokens (density × ratio), so CJK and base64 stay within their share. | `maxUnitFraction` (0.25) | `h6-unit-density.test.ts :: h6 <cjk, base64> unit stays within its share of the budget in o200k tokens (mode a)` |
| E4.3 | planner, state | Cap decisions are frozen per entry and persisted as `{kind:"caps"}`. Reload, resume and fork send the same capped text, although the ratio moved. | none | `b03-cap-decisions-persist.test.ts :: b03 the same capped text and placeholder after reload, resume and fork` |
| E4.4 | estimator, planner | An image costs max(85, min(1,600, ⌈w×h/750⌉)) tokens (`defaultImageTokens` when the size cannot be read). Images over the unit budget become recallable placeholders. | `defaultImageTokens` (1,600) | `h6-unit-density.test.ts :: h6 a tool result with 20 large screenshots fits and the images stay recallable (mode a)` |
| E4.5 | planner | At a cut, the newest images within `imageShare` of the budget are kept and older ones are replaced. | `imageShare` (0.5) | `h6-unit-density.test.ts :: h6 screenshots across a session stay within the window, prefix-stable (mode a)` |
| E4.6 | tools/recall | `context_recall` returns text in pages of 0.9 × the unit cap, and images by block index. | `maxUnitFraction` | `oversized.test.ts` (text); `h6-unit-density.test.ts :: h6 a tool result with 20 large screenshots ...` (images) |
| E4.7 | tools/search | `context_search({ query, scope?, limit? })` is a case-insensitive search over this session's entries; every word must occur. The default scope is out of view: before the current cut, omitted by a context edit, or shown capped. `scope: "all"` searches everything. It skips its own and `context_recall`'s results and the assistant messages that called it. It finds custom messages (role `custom(<type>)`) and branch summaries. D16: a tool result is searched together with its call's argument values (paired in branch order; empty ids pair nothing), a hit on a message with tool calls names the results of the calls that matched (`result: <id>`), and a result matched only through its call is left out when its call is a hit (else marked `call: `); when no entry has every word, the entries with some are listed, most words first, marked `k of n words`. Each hit gives entry id, turn, role, in or out of view and a snippet, newest first, bounded; it says how many more matched. Searching and recalling only append, so the prefix still changes only at cuts. | `searchMaxResults` (10), `searchMaxChars` (4,000) | `context-search.test.ts :: search finds an out-of-view entry, recall reads it, results are bounded, the prefix stays stable`, `search output respects a small character bound`; `b12-context-search-cases.test.ts` (4 tests: context edit, custom message, branch summary, `getActiveTools()` throwing); `d16-search-tool-call-arguments.test.ts :: d16 s14: both of the model's queries find the read result, and recall returns the approval code` |

## E5: Overflow recovery without summarization

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E5.1 | recovery | A final attempt that overflows triggers four steps: learn the window, omit the failed attempt, re-cut, and continue, at most `maxOverflowRetries` times per run. | `maxOverflowRetries` (3) | `recovery.test.ts :: mode a, compaction.enabled=<false, true>: injected overflow at provider call <0, 12, 60> is retried once` (6 tests) |
| E5.2 | limits | Wrong (too large) window metadata: the real limit is learned from the rejection. | none | `recovery.test.ts :: mode a: wrong (too large) window metadata, provider rejects above a smaller real limit` |
| E5.3 | limits, detector | A learned window is evidence, not fact. It is re-probed after clean requests near it (0.5× the window); a failed re-probe counts as a confirmation and doubles the wait; after `probeConfirmations` it is permanent. A window learned from an error with no number is re-probed after `probeAfterUnparsed` requests. | `probeAfterParsed` (16), `probeAfterUnparsed` (8), `probeConfirmations` (2) | `h3-window-expiry.test.ts :: h3 mode a: one bad route does not shrink the window for good`, `h3 mode a: a genuinely smaller limit holds with bounded probing`; `b07-unparsed-reprobe.test.ts :: b07 one number-less overflow: the window is learned unparsed, re-probed after 8 clean requests, and retired` |
| E5.4 | detector | Only a successful request above the learned limit retires it. Stepping the probe up to the window does not. | `probeConfirmations` (2) | `h8-ceiling.test.ts :: h8 a learned window below the ceiling converges: re-probes that fail near it end probing` |
| E5.5 | recovery | Provider errors are classified before Pi's `isContextOverflow`. Rules in order: rate limits (unknown), stated output limits, combined errors, context overflow (the engine's patterns and Pi's), output limits without numbers, unknown. | `MIN_OUTPUT_ROOM` (1,024, constant) | `g1-output-errors.test.ts :: g1 classify <fixture> (<provider>) as <class>` (36 tests, one per fixture in `g1-error-fixtures.ts`) |
| E5.6 | recovery, limits | A combined error whose input alone does not fit (input + 1,024 > context) is an overflow, learned from the stated input part. | none | `g1-output-errors.test.ts :: g1 classify openrouter-combined-input-too-long (OpenRouter) as context-overflow`, `g1 classify tgi-overflow (Hugging Face TGI) as context-overflow` |
| E5.7 | recovery | Fault injection (D1) turns successful responses into overflow errors, output-limit errors or length stops (text halved), on a schedule (`at`, `every`) or with a seeded probability. Off by default. Only `PENPI_FAULTS` turns it on (`overflow=every:7;output-limit=p:0.1;length=at:3,9;seed=42`, or JSON); tests may pass the `faults` option. When several kinds fire on one response, overflow wins, then output-limit, then length. The engine recovers as from real faults. | `faults` (none), `env` (process.env) | `d1-fault-injection.test.ts :: d1 off by default: no faults, no flag, doctor says off`, `d1 schedule: each kind fires where asked, loudly, and the engine recovers`, `d1 priority: overflow beats output-limit beats length on one response`, `d1 probability: seeded and repeatable`, `d1 env var PENPI_FAULTS turns it on; the spec parser reads both forms` |
| E5.8 | recovery | Fault injection is refused when `PENPI_PRODUCTION` is 1, true or yes, or when the `production` option is set (tests). The refusal is logged and warned, and doctor says REFUSED. `penpi.faults` and `penpi.production` are not settings: PENpi ignores them with a warning. | `production` (unset) | `d1-fault-injection.test.ts :: d1 guard: PENPI_PRODUCTION=1 refuses fault injection`, `d1 guard: the production option refuses fault injection`, `d1 guard reads the real process environment`; settings: the engine's unit tests (below) |
| E5.9 | recovery, tools/doctor | Fault injection is loud: a startup banner (log, console, UI warning), one log line and warning per fault, the status line prefixed `FAULTS ON · `, and a doctor line with the rules and the count. ACTIVE is announced only at session start, so a refused switch never prints it. | none | `d1-fault-injection.test.ts :: d1 schedule: ...`; the `d1 guard: ...` tests assert that no ACTIVE line is logged or warned |

## E6: Length continuation

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E6.1 | recovery | A text answer cut by a length stop is continued with a context-only message, at most `maxLengthContinuations` times per run. | `maxLengthContinuations` (3) | `length.test.ts` (6 tests) |
| D15 | recovery | A length stop with no visible text and no tool call (all output went to reasoning) gets its own message: give the answer or the next tool call directly. `"continue"` sends the ordinary message. The cap of 3 per run holds for repeated stops and resets for the next run. | `reasoningOnlyContinuation` ("answer"), `maxLengthContinuations` (3) | `d15-reasoning-only-continuation.test.ts :: d15 a reasoning-only stop gets the answer-directly message`, `d15 a stop that wrote visible text keeps the continue-where-it-stopped message`, `d15 reasoningOnlyContinuation "continue" sends the old message after a reasoning-only stop`, `d15 repeated reasoning-only stops: at most 3 continuations per run, reset for the next run` |
| E6.2 | recovery | A length stop at the engine's own lowered clamp raises the output (×2, at most `hardWindow`/2) for the retry. | `defaultMaxOutput` (16,384) | `h4-output-limits.test.ts :: h4 tool call above 4k output tokens succeeds: <model>` (3 models) |
| E6.3 | recovery, limits | Two equal stops below the request teach the provider's output ceiling. A cut-off tool call then gets a split hint. | none | `h4-output-limits.test.ts :: h4 learns the provider's real output ceiling and tells the model to split the call` |
| E6.4 | recovery | A 10k-token answer for a 200k / 100k model is not chopped into continuations. | none | `h4-output-limits.test.ts :: h4 does not chop a 10k-token answer into continuations for a 200k / 100k model` |
| E6.5 | state | Learned output state (ceiling, raised output, stated context) survives reload and resume. | none | `b04-output-state-persists.test.ts :: b04 learned output state survives reload: the same max_tokens on the first request after reload and resume` |

## E7: Effective limits

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| D3 | options | An option given as undefined keeps its default; only null (or 0 where documented) switches a feature off. A partial pin object is completed from `PIN_DEFAULTS`. | all | `d3-option-defaults.test.ts :: d3 every option set to undefined resolves to the defaults`, `d3 with every option undefined, a 1M model still plans within 200k and pins after a cut` |
| E7.1 | limits | A model missing from the registry uses min(declared, `defaultWindow`). A model with no window uses `defaultWindow`. | `defaultWindow` (32,768) | `limits.test.ts :: treats a model missing from the registry as unverified and uses the default window`, `reports what upstream sends for a model with neither window nor maxTokens`; `recovery.test.ts :: mode a: model with no context window uses the conservative default` |
| E7.2 | limits | Per-model overrides by `provider/modelId` (window and/or output). `modelLimits` is an alias merged over `limitOverrides`. | `limitOverrides` ({}), `modelLimits` (unset) | `limits.test.ts :: applies an override map (window and output)`; `h8-ceiling.test.ts :: h8 precedence: a per-model window override beats the ceiling; a maxTokens-only override does not` |
| E7.3 | limits | A declared max output above `implausibleOutputFraction` × the window is implausible. The default is used instead, capped at window/2. | `implausibleOutputFraction` (0.75), `defaultMaxOutput` (16,384) | `limits.test.ts :: clamps the requested output when maxTokens is implausible (above 0.75 of the window)`; `h4-output-limits.test.ts :: h4 tool call above 4k output tokens succeeds: GLM-5.3-Flash refreshed (1,048,575 / 943,717)` |
| E7.4 | limits | `before_provider_request` only ever lowers the output field, in 7 shapes: `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `maxTokens`, `maxOutputTokens`, `generationConfig.maxOutputTokens`, `inferenceConfig.maxTokens`. A value below the allowed output is left alone, and so is a cache-warming request's 1. | none | `b05-output-clamp-shapes.test.ts :: b05 <shape>: lowered above the allowed output, never raised; max_tokens 1 untouched` (7 tests) |
| E7.5 | limits | A thinking budget is squeezed only when `max_tokens` was lowered. | none | `h4-output-limits.test.ts :: h4 does not squeeze an Anthropic thinking budget for a 200k / 100k model` |
| E7.6 | limits | The engine plans against min(model window, `windowCeiling`). 0 or null disables the ceiling. | `windowCeiling` (200,000) | `h8-ceiling.test.ts :: h8 glm-1m (1048575/943717) stays inside the 200k-derived budget and cuts`, `h8 glm-fallback (262144/262144) stays inside the 200k-derived budget and cuts`, `h8 the ceiling disabled restores full-window planning` |
| E7.7 | limits | A model at or below the ceiling behaves byte for byte the same with the ceiling on or off. | `windowCeiling` | `h8-ceiling.test.ts :: h8 a 128k model is byte-for-byte the same with and without the ceiling` |
| E7.8 | limits | Precedence: an explicit per-model `contextWindow` override bypasses the ceiling; a maxTokens-only override does not; a smaller learned window wins over both. | `limitOverrides`, `windowCeiling` | `h8-ceiling.test.ts :: h8 precedence: ...`, `h8 a learned window below the ceiling still applies` |
| E7.9 | limits | Output reserve = min(maxOutput, ⌊`outputReserveFraction` × capped window⌋). Budget = window − reserve. | `outputReserveFraction` (0.2) | `h8-ceiling.test.ts :: h8 output reserve = min(max output, 20% of the capped window); a request may still ask for more` |
| E7.10 | limits | A request may ask for max(256, min(maxOutput, hardWindow − input − 512)). hardWindow is the declared or override window, lowered by a learned window and by a context stated in a G1 error. | none | same test as E7.9 |
| E7.11 | limits | An output-limit error sets the output ceiling: the number stated, or else half of what was asked, never below `minOutputLimit`. It is learned at `message_end` and retried at most `maxOutputRetries` times per run. The window is unchanged. | `maxOutputRetries` (3), `minOutputLimit` (1,024) | `g1-output-errors.test.ts :: g1 e2e <fixture>: ceiling learned from the message, retried, window unchanged` (8 fixtures), `... ceiling stepped down, retried, window unchanged` (2 fixtures) |
| E7.12 | limits | A combined error whose input fits (input + 1,024 ≤ context) raises the ratio from the stated input, bounds output room by the stated context, sets a one-shot retry cap of context − input − 256, and leaves the window unchanged. The cap is spent only by a request that asks for more than it, so a cache-warming request (max_tokens 1) leaves it for the retry. | `maxOutputRetries` (3) | `g1-output-errors.test.ts :: g1 e2e <fixture>: output room learned, retried, window unchanged` (7 fixtures); `b06-one-shot-cap-warm.test.ts :: b06 a cache-warming request between the error and the retry leaves the cap for the retry (<fixture>)` |
| E7.13 | recovery | No infinite loop. Retries stop at `maxOutputRetries`, or when no lower output is left, and the error then surfaces. | `maxOutputRetries` (3), `minOutputLimit` (1,024) | `g1-output-errors.test.ts :: g1 e2e no number and no output the provider accepts: bounded, then the error surfaces` |
| E7.14 | recovery | Learning at `message_end` means Pi's own transient retry already uses the learned ceiling. That retry fires on errors whose digits contain "500", "429" and so on, e.g. `max_tokens is too large: 15000`. | none | `g1-output-errors.test.ts :: g1 e2e openai-chat-output-retryable-digits: ceiling learned from the message, retried, window unchanged` |

## E8: Header, notes and the user-message pin

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| E8.1 | header, tools/notes | `context_notes` replaces a size-capped notes block that every header carries. It can also set the pinned task, which stays pinned with the pin on. | `notesMaxChars` (4,000), `taskMaxChars` (2,000) | `notes.test.ts :: mode a: notes and task stay in context after older messages leave` |
| E8.2 | header, pin | The current request (the prompt of the latest run, `{kind:"run"}`) is identifiable after a cut: once it has left the window, the pin carries it labelled "current request". The label holds as of the cut. | `pinUserMessages` (on), `taskMaxChars` (2,000) | `h5-pinned-task.test.ts :: h5 mode a: the latest run's prompt is labelled current request in the pin once it left the window` |
| E8.3 | header, pin | A short prompt is the current request, with the earlier task still carried. The next long prompt becomes the current request; the earlier two stay carried, labelled already handled (D26), in order. Neither `<pinned-task>` nor `<latest-instruction>` appears. | `pinUserMessages` (on) | `d2-short-prompts.test.ts :: d2 a short prompt is carried as the current request with the earlier task still pinned; a long prompt takes over` |
| E8.4 | header, pin | A short first prompt is the current request. | `pinUserMessages` (on) | `d2-short-prompts.test.ts :: d2 a short first prompt is the current request` |
| D10 | header | One run record kind for every prompt. With the pin off (`pinUserMessages: null`), the latest run's prompt is the `<pinned-task>`, short or long. Older sessions' `{kind:"latest"}` records are still read as the latest instruction. | `pinUserMessages` | `d2-short-prompts.test.ts :: d10 with the pin off, a short prompt becomes the pinned task and there is no latest instruction` |
| D6 | header | An image-only prompt starts a run and becomes the current request. | none | `d6-image-only-current-request.test.ts :: d6 an image-only prompt after a text prompt is labelled current request` |
| E8.5 | header | The header states the window number, how many messages left, the first kept entry, and that nothing was summarized or deleted. It names only active recovery tools: `context_search`, `context_recall`, `search_transcript` (PENpi's, earlier sessions) and `context_notes`. | none | `context-search.test.ts :: search finds an out-of-view entry, ...`, `the header names search_transcript only when that tool is active (PENpi)` |
| P2 | pin | Standing instructions survive cuts: the header carries the user messages that left the window, verbatim, oldest first. A long paste is a pointer. A later message that revokes a rule is carried after it. The pin is off with `pinUserMessages: null`. | `pinUserMessages` (on), `longMessageChars` (2,000) | `pin-user-messages.test.ts :: rules survive 3+ cuts with the pin; without it (pin off: the pinned task and latest instruction only) they are gone`, `a long paste is carried as a pointer for context_recall, not verbatim`, `a later user message that revokes an earlier rule is carried after it, in order (the model sees both)`, `includes the H5 task: the run's prompt, once out of the window, is carried as the current request; a context_notes task stays pinned` |
| P2b | planner, pin | The header is planned at the cut and never below the header rendered there. With the pin off no header plans are recorded. Images are markers; an image-only message is an image line. | none | `pin-user-messages.test.ts :: P2b: the header is planned at the cut: never below the header rendered there, on a session with many user messages`, `with the pin off the planner records no header plans`, `P2b: images in user messages are carried as markers; an image-only message as an image line` |
| A1 | pin | Only messages a person typed: the input source is recorded at the input event (`{kind:"source"}`) and survives a resume. Interactive and rpc are pinned; extension messages only when configured. Entries with no recorded source follow `unrecordedSource`. PENpi 0.4's own continuation prompts are never pinned. | `sources` (["interactive", "rpc"]), `unrecordedSource` ("pin") | `pin-sources.test.ts :: A1: interactive and rpc messages are pinned; an extension message is not by default, and is (labelled) when configured`, `A1: sources survive a resume; messages from older sessions (no recorded source) are pinned by default and left out with unrecordedSource skip; D2: PENpi's old continuation prompts never` |
| D7 | pin, tools/doctor | Source pairing never picks a stale input: an idle input still pending at the next idle input is dropped, and pairing tries an exact text match first. | none | `d7-input-source-pairing.test.ts :: d7 an extension handles one input; the next interactive message is recorded as interactive` |
| A2, D5 | pin | A long current request keeps its first `taskMaxChars` characters plus a pointer. The head, offset and length come from the text `context_recall` reads; images are listed apart. An extension-sent current request is still carried. | `taskMaxChars` (2,000) | `pin-sources.test.ts :: A2: a long current request keeps its first taskMaxChars characters plus a pointer; an extension-sent current request is still carried, labelled`; `d5-current-request-image.test.ts :: d5 current request with an image and 3,000 characters: the pointer's offset reads exactly the rest` |
| A3, D9 | pin | Cap = min(`capFraction` × planning window, `capMaxTokens`), in provider tokens: compared with the calibrated estimate. The cap scales with the window ceiling. | `capFraction` (0.1), `capMaxTokens` (20,000) | `pin-sources.test.ts :: A3: the cap is min(10% of the window, 20,000): 20,000 on a 1M model with the ceiling disabled`; `pin-user-messages.test.ts :: the cap scales with the window ceiling: 10% of 100k on a 1M model (E4 arm D'), 10% of 200k as control`; `d9-pin-cap-calibrated.test.ts :: d9 a CJK pin at a 1.7 calibration ratio stays within the cap in provider tokens`; `properties.test.ts` (header) |
| A4, A5, A7 | pin | Over the cap, in order: middle messages become pointers (oldest first), then range lines, then the protected first messages become pointers (newest first), then the current request. A pointer carries the first 200 characters. Every decision is logged and the pin size is recorded per request. Age is the order the prompts were sent (D11). | `protectFirst` (3) | `pin-sources.test.ts :: A4/A5/A7: pass order, 200-character pointers, every decision logged, pin size per request`; `pin-user-messages.test.ts :: cap holds: the first 3 stay verbatim, the middle goes first, oldest first (the newest middle message stays longest)` |
| D8 | pin | Pointer, head and range lines name `context_recall` and `context_search` only while those tools are active. | none | `d8-pointers-inactive-tools.test.ts :: d8 pin pointers with the tools inactive name neither context_recall nor context_search` |
| AP | pin | A message starting with an agent prefix is labelled as typed by the manager agent. | `agentPrefixes` (["[manager]"]) | `pin-sources.test.ts :: addendum 1: a [manager]-prefixed message is labelled as typed by the manager agent` |
| D26.1 | header, pin | The current request still in the window at the cut is named by a line of its own (its id, *in your context below*, its first 200 characters); it is not carried, and every carried message is labelled already handled. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 the current request still in the window is named (id, in your context below, first words), not carried; the earlier ones are handled` |
| D26.2 | header, pin | A pinned current request is marked current request (never already handled), and the line names it as marked in the pinned messages above. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 the current request pinned: marked current request (not handled) and named by the line as marked above` |
| D26.3 | header, pin | A run with no current request (a resumed session without run records) gets no current-request line; every carried message is labelled already handled. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 no current request (a resumed session without run records, continued): no current-request line, every carried message handled` |
| D26.4 | pin, planner | Pointer, range and image lines keep the already-handled label and the date; the cap and the header bound hold with the longer markers. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 pointer, range and image forms keep the handled label and the date; the cap and the header bound hold` |
| D26.5 | pin | Every marker carries the UTC day its message was sent. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 dates: each marker carries the UTC day its message was sent` |
| D26.6 | header, pin | After an interrupted task and *Keep going* as the current request, the task is handled *unless the current request asks you to*, and the line names Keep going. | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 an interrupted task, then 'Keep going' as the current request: the task is handled unless the current request asks, and the line names Keep going` |
| D26.7 | header | Within a window every request carries the identical header (D26 text is fixed at the cut). | `pinUserMessages` (on) | `d26-handled-pins.test.ts :: d26 byte stability: within a window every request carries the identical header` |
| D26.8 | planner, state | Every new cut entry records the header format (`hv`). | none | `d26-header-format.test.ts :: d26 every new cut entry records the header format` |
| D26.9 | planner | A session whose latest cut has an older or no format cuts once, at its first aligned request, logged with the reason; the header is then in the current format. | none | `d26-header-format.test.ts :: d26 an old-format session cuts once, at its first request, logged with the reason; the header is in the current format` |
| D26.10 | planner | A current-format session does not cut for the format; a session with no cut entry is untouched. | none | `d26-header-format.test.ts :: d26 a current-format session does not cut for the format; a session with no cut entry is untouched` |
| D26.11 | planner, state | The forced cut records sections (D19) and applies a pending refresh (E8.14) exactly as an ordinary cut does. | none | `d26-header-format.test.ts :: d26 sections (D19) and a pending refresh behave as at any cut` |
| D26.12 | planner, state | After the forced cut, a /compact rebuild and a second resume do not cut for the format again (both see `hv` current). | none | `d26-header-format.test.ts :: d26 after the forced cut, a /compact rebuild and a second resume do not cut for the format again` |
| D26.13 | planner, state | A session whose only cut-like entry is Pi's native compaction (no engine details) has no cut for the check and is untouched. | none | `d26-header-format.test.ts :: d26 a session whose only cut-like entry is Pi's native compaction is untouched` |
| TC.1 | repair, planner | A provider tool call with no name (with or without an id) is sent as a fixed, neutral note in its assistant message, and its result ("Tool  not found") is left out, so the request has no empty tool_call_id. The session file keeps the raw entries. The next request repeats the repaired messages byte for byte. Logged once per kind, counted in `/penpi doctor`. | none | `rc6-tool-call-repair.test.ts :: rc6 a call with no id and no name: the next request is valid and stays the same; the session keeps it` |
| TC.2 | repair, planner | A call with a real name and no id keeps its result: the call and the result get the same id, made from the stored message (`penpi_<timestamp>_<index>`). Calls and results with an empty id pair first in, first out, checked by tool name. On a mismatch, no result, or an id already in the request, the call becomes a note and the result is left out. | none | `rc6-tool-call-repair.test.ts :: rc6 a call with a real name and no id: the tool's output is kept under one stable id`; PENpi's `engine/repair.test.ts` |
| TC.3 | repair, planner | A request with no broken tool call is sent unchanged (the repair returns the same array, nothing is counted or logged). | none | `rc6-tool-call-repair.test.ts :: rc6 a session with valid tool calls is sent unchanged`; PENpi's `engine/repair.test.ts` |
| TC.4 | repair, planner | The request estimate and the silent-truncation appended estimate count the repaired request (as D17). | none | `rc6-tool-call-repair.test.ts :: rc6 a call with no id and no name: the next request is valid and stays the same; the session keeps it` |
| TC.5 | repair, planner | Stock s01's broken session from the 0.5.0 bench (trimmed, `samples/s01-empty-tool-call.jsonl`): all 12 requests after the broken call are valid, and the session file keeps its entries. | none | `rc6-tool-call-repair.test.ts :: rc6 stock s01: all 12 requests after the broken call are valid, and the session file keeps its entries` |
| EQ | all | With the pin off and the notice on, the engine sends exactly what the reference engine `reference/p2-context-engine.ts` sends, request for request (context cuts and overflow recovery). | `pinUserMessages: null`, `notice: true` | `pin-off-equivalence.test.ts :: mode a, <cuts, overflow> (<path>): every request identical to the reference engine (pin off, notice on)` |

## Every request: properties

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| PR | all | Over seeded random sessions on windows of 8k, 32k, 128k, 200k and 1M tokens, every request: **fit** (an honest provider never rejects; prompt + max_tokens ≤ window), **validity** (starts with a user message; every tool call paired with its result), **prefix** (exactly one prefix break per cut), **header** (within its planned bound; the pin within its cap, calibrated). | defaults | `properties.test.ts :: window <w>, seed <s>: fit, validity, prefix and header` (5 windows × 3 seeds) |

## PENpi integration

| ID | Module | Behaviour | Config (default) | Test |
|---|---|---|---|---|
| BR | (PENpi) | The orientation briefing is a system prompt section, never a message. It stays in view after cuts and the engine's budget counts it. It is byte-stable within a session and changes only at a cut: a changed briefing read after a run reaches the system prompt with the engine's next cut. The memory is fenced, JSON-encoded data after a line saying it is not instructions. | none | `penpi-briefing.test.ts :: stays in view after cuts, is never a message, and keeps the system prompt stable`, `is byte-stable across prompts when Penfield changes with no cut, and refreshed at the next cut`, `counts toward the engine's budget: the estimate grows by the briefing's size` (and HID above); PENpi's `index.test.ts` (the fence and JSON encoding) |
| SEC | planner | A host changes a system prompt section only at a cut (`setSectionAtNextCut`): the cut's checkpoint carries it, older copies of the section in the kept window are left out, and the cut entry records it, so a rebuilt window sends the same prompt. A newer system message (the host's text at a new session) wins. | none | `system-section-at-cut.test.ts :: arrives with the first cut request, survives an older copy in the window and a rebuild; a resume starts fresh` |
| LOG | telemetry, entry | `PENPI_ENGINE_LOG=<path>` writes the engine's log lines (timestamped) and one telemetry report per request, and emits the report as the status `context-engine.telemetry`. The log holds no prompt or message text; quoted provider error text is replaced by its length. Unset or blank: no writer, no file, no status. | `PENPI_ENGINE_LOG` (unset) | `engine-log.test.ts :: with PENPI_ENGINE_LOG: engine lines and telemetry in the file, telemetry as a status, no prompt or message text`, `without PENPI_ENGINE_LOG (unset): no log writer, so no file, and no telemetry status`, `without PENPI_ENGINE_LOG (empty): ...` |
| SET | settings, entry | The `penpi` block is validated, not coerced; FIFO's settings and variables are named as no longer used; both entry points resolve identical options. | none | the engine's unit tests next to its modules in `.pi/extensions/penpi/engine/` (settings, entry points, log redaction), run with PENpi's extension tests |

## Status line and doctor (tools/doctor)

| ID | Behaviour | Config (default) | Test |
|---|---|---|---|
| T.1 | Status line: `[FAULTS ON · ]ctx <window>[ (model <declared>, <reason>)][ · req <request>/<cut threshold>] · <n> cuts · ratio <r>`. Updated on every request and at session start. | none | `h8-ceiling.test.ts :: h8 glm-1m ...`, `h8 a 128k model's status ...`, `h8 a learned window below the ceiling still applies`; `d1-fault-injection.test.ts :: d1 schedule: ...` |
| T.2 | `/penpi doctor` prints: model; declared window and max output (implausibility noted); effective window and reason (ceiling, override); max output; output reserve; input budget; band; calibration; silent-truncation detection (or unavailable: no usage); replayed reasoning; learned windows with evidence and expiry; learned output; unit caps; window number; user-message pin; pre-cut notice; `compaction.enabled`; fault injection. | `commandName` ("penpi") | `h8-ceiling.test.ts`; `d1-fault-injection.test.ts`; `g2-plateau-report.test.ts :: g2 names ...`; `b14-no-usage-doctor.test.ts`; `replayed-reasoning.test.ts :: doctor names replayedReasoning ...` |
| T.3 | `/penpi reset-limits` clears the session's learned windows (plateau included), output ceilings, raised outputs and context bounds, re-arms the plateau warning and persists the cleared state. The detector then fires and warns again. | none | `g2-plateau-report.test.ts :: g2 names the truncated turns ...; reset clears`; `b08-detect-after-reset.test.ts :: b08 truncate, detect, reset, truncate again: a second warning` |

## Formerly untested behaviours

The headers of the `b*` tests cite these items by number.

| Item | Behaviour | Test |
|---|---|---|
| 1 | E2.11 checkpoint | `b01-system-checkpoint.test.ts` |
| 2 | E3.3 ratio bounds | `b02-ratio-clamp.test.ts` |
| 3 | E4.3 frozen caps across reload, resume, fork | `b03-cap-decisions-persist.test.ts` |
| 4 | learned output state across reload (E6.5) | `b04-output-state-persists.test.ts` |
| 5 | E7.4 never-raise and the 7 payload shapes | `b05-output-clamp-shapes.test.ts` |
| 6 | G1's one-shot cap and cache warming (E7.12) | `b06-one-shot-cap-warm.test.ts` |
| 7 | re-probe of an unparsed learned window (E5.3) | `b07-unparsed-reprobe.test.ts` |
| 8 | detection after `/penpi reset-limits` (T.3) | `b08-detect-after-reset.test.ts` |
| 9 | D1 rule priority (E5.7) | `d1-fault-injection.test.ts :: d1 priority: overflow beats output-limit beats length on one response` |
| 10 | mode coverage | no longer applies: mode a is the only mode |
| 11 | H7 bar below 1 ms engine time (E2.6) | `h7-scaling.test.ts` (opt-in) |
| 12 | `context_search` edges (E4.7) | `b12-context-search-cases.test.ts` |
| 13 | E3.9 quarantined samples and the ratio | `b13-quarantine-ratio.test.ts` |
| 14 | a server that reports no usage (E3.13) | `b14-no-usage-doctor.test.ts` |

## Behaviours without a dedicated test

1. **D10, older sessions:** that an old `latest` record is read as the latest instruction.
2. **E5.1's bound:** that overflow retries stop after `maxOverflowRetries` (3) in one run. The tests inject one overflow at a time.
3. **Small truncation:** a server that truncates by less than about 25 % of each append, or appends below `silentMinGrowth`, is not detectable by this design. No test shows the limit.

## How the tests run

Once per checkout, from the repository root:

```
npm run setup:tokenizers
```

Then, from the repository root (also part of `npm test`):

```
npm run test:context-engine
```

- Each test starts with deterministic session entry ids (D13: `deterministic-ids.ts`, a vitest setup file).
  Ids appear in headers and pointers, so random ids moved the estimate by a token between runs.
- Tests write their reports under this folder's `.cache/out`. `CONTEXT_ENGINE_OUT` moves it.
- `CONTEXT_ENGINE_BASELINE=1` runs the suite against the engine's first version,
  `reference/r1-context-engine.ts` (`CONTEXT_ENGINE_BASELINE_PATH` names another file). Exports it lacks are
  undefined, so most later tests fail there by design.

Three suites are opt-in:

| Variable | Suite |
|---|---|
| `CONTEXT_ENGINE_SCALE=1` | `h7-scaling.test.ts` (H7, 20,000 turns; `CONTEXT_ENGINE_SCALE_TURNS`) |
| `CONTEXT_ENGINE_BENCH=1` | `bench.test.ts` (2,000 turns; `CONTEXT_ENGINE_BENCH_TURNS`) |
| `CONTEXT_ENGINE_CEILING_TABLE=1` | `h8-ceiling-table.test.ts :: h8-table <model> ceiling <100000, 200000, 400000, none>` (reports numbers; asserts only that each run completes) |

`scripts/engine-suite-upstream.sh` runs the suite against stock upstream Pi at the recorded base, so the
engine is shown to work as a plain Pi extension. CI runs it as the job `engine-on-upstream`. It leaves out
`engine-log.test.ts` and `penpi-briefing.test.ts`, which load PENpi's extension.

E2, the real-tokenizer matrix with silent-truncation criteria, lives in `../context-engine-e2`. Its README
describes the runs and the criteria.

## Index by module

| Module | Behaviours |
|---|---|
| estimator | E3.1, E4.4 |
| serializer | B1, D4, B2, RR |
| detector | E3.2, E3.5, E3.6, E3.9, E3.10, E3.11, E3.12, E3.13, E5.3, E5.4 |
| state | E2.3, E3.3, E3.4, E3.7, E4.3, E6.5, D26.8, D26.11–D26.13 |
| limits | E3.8, E3.10, E5.2, E5.6, E7.1–E7.12 |
| planner | E2.1, E2.2, E2.6, E2.7, E2.8, E2.10, E2.11, E2.12, HID, E4.1, E4.2, E4.3, E4.4, E4.5, P2b, D26.8–D26.13, TC.1–TC.5 |
| repair | TC.1–TC.5 |
| pin | E8.2, E8.3, E8.4, P2, P2b, A1, A2, A3, A4, A5, A7, AP, D5, D7, D8, D9, D26.1–D26.7 |
| header | E1.3, E2.10, E8.1–E8.5, D6, D10, D26.1–D26.3, D26.6, D26.7 |
| recovery | E1.1, E1.2, E1.5, E5.1, E5.5–E5.9, E6.1–E6.4, D15, E7.13, E7.14 |
| tools/doctor | E1.4, E3.13, E5.9, RR, D7, T.1, T.2, T.3 |
| tools/notes, recall, search | E8.1, E4.6, E4.7 |
| options | D3 |
| entry, settings, telemetry | LOG, SET, BR |
