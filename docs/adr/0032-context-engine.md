# 32. Replace FIFO with the context engine

- Status: Accepted
- Date: 2026-10-17

## Context

FIFO (ADR 0003) pruned the oldest messages against a chars/4 estimate, and needed escape hatches
for what it could not handle. These were overflow compaction for a unit too large for the window
(ADR 0023), emergency compaction for a model without a context window (ADR 0025), a budget that
ignored calibration (ADR 0027) and a separate length continuation (ADR 0028). Each patched one
failure, and two of them brought back the LLM summaries that ADR 0003 set out to remove.

The context engine was developed as a stand-alone Pi extension and evaluated in two ways. E2, in
this repository (`packages/coding-agent/test/suite/context-engine-e2`), simulates long sessions
against real tokenizers and providers that reject or silently truncate. A paid benchmark with real
models (October 2026) compared the engine with FIFO and with compaction. The version that passed is
the one ported here, together with a list of defects to fix and behaviours that had no test.

## Decision

PENpi 0.5.0 replaces FIFO with the context engine, described in
[CONTEXT_ENGINE.md](../CONTEXT_ENGINE.md). It is a persistent window with hysteresis, saved as
session entries. A header after each cut carries the user's earlier messages and the model's
notes. Estimates are calibrated per model from what Pi serializes. Window and output limits are
learned, including silent truncation, and overflow and length stops are recovered without
compaction. Nothing is summarized or deleted.

- **Removed:** `fifo.ts`, emergency compaction (0025), PENpi's `agent_end` length continuation
  (0028), the `session_before_compact` gate and the compaction-disabled recovery gating in
  `agent-session.ts` (0023, now back to upstream). Also removed are the settings
  `contextFloor`, `contextCeiling` and `emergencyCompactionRuns` and their environment variables;
  PENpi warns at startup when one is set and names it.
- **Kept:** compaction off by default (`settings-manager.ts`). The engine refuses to run when
  `compaction.enabled` is true. When the setting is unset, PENpi says compaction is off through
  the engine's `compactionOffByDefault` wiring, so that stock Pi with the setting unset still
  refuses. Print mode prints every part of a continued answer, and accepts the engine's hidden
  continuation message as a follow-up.
- **Where it lives:** `.pi/extensions/penpi/engine/`, in modules (core, estimator, serializer,
  detector, limits, planner, pin, header, recovery, state, tools). The prototype was one file; the
  split preserves its behaviour, which the suite and E2 check. The prototype's comparison modes and
  its notice cache surgery are not part of PENpi.
- **Settings:** engine settings go in the `penpi` block of the global settings. They are validated,
  not coerced (ADR 0030). Fault injection is not a setting: only `PENPI_FAULTS` turns it on, and
  `PENPI_PRODUCTION=1` refuses it.
- **Two entry points, one engine:** the full extension and `engine-only.ts` (the benchmark's entry,
  without Penfield memory, which would carry facts across sessions) both call `installPenpiEngine`.
  A test checks that they resolve identical options.
- **Opt-in log and telemetry:** `PENPI_ENGINE_LOG=<path>` writes the engine's log and one telemetry
  report per request, and emits the report as the status `context-engine.telemetry`. Without the
  variable, nothing is written or emitted. The log holds ids, sizes, ratios and decisions, never
  prompt or message text: quoted provider error text is replaced by its length. Tests check both.
- **Session entries:** the cut entry is the prototype's (`{ kind: "cut", firstKeptEntryId, seq,
  header }`).

The defects found before the port (D3 to D15) are fixed, each covered by a test (the behaviour
table, `test/suite/context-engine/BEHAVIOURS.md`, maps them), and each behaviour that had no test
now has one. Writing those tests found one more defect: a
cache-warming request between an output-caused error and its retry took the one-shot output cap
(G1), so the retry went out uncapped. The cap is now spent only by a request that asks for more
than it. The sections below record the choices the port made, with their evidence.

## Decisions made in the port

### D14 and the E2 criterion C8

D14 names, at detection, every recent sample expected above the learned window by more than
`plateauFlatness`. C8 originally asked that the named answers equal the truncated requests in every
silent E2 run. With D14 as first written, C8 still failed in 5 of 48 silent runs:

| run | call | real tokens lost | why |
|---|---|---|---|
| research.o200k.1m.silent-messages | 45 | 1,642 of 101,004 (1.6%) | below the engine's estimate error |
| research.o200k.128k.silent-messages | 36 | 1,642 of 66,903 (2.5%) | below the estimate error |
| coding.glm.1m.silent-messages | 31 | 48 of 100,045 (0.05%) | below the estimate error |
| coding.glm.32k.silent-front | 9 | 965 of 17,349 (5.6%) | 16 samples before detection at 26: outside the 16-sample recent list |
| data.glm.32k.silent-messages | 10 | none | named without truncation: the estimate was 5.7% high |

The engine sees only its estimate, a few percent off (on the data mix -8% to +37%), so exact
equality is unreachable for any rule based on the expected size. Decided:

- the engine keeps `silentEvidenceSpan` (30) recent samples instead of 16, so an answer truncated
  long before detection can still be named;
- C8 fails a silent run when a truncated request that lost more than `plateauFlatness` plus the
  engine's estimate error at that call (|estimate x ratio - real| / real) is not named. The band was
  fixed before any run was evaluated with it. The error it allows is capped at 5% of the request,
  so a worse estimator cannot buy itself exemptions. Truncations inside the band and answers named
  without truncation do not fail a run; the E2 summary lists them per run, with totals;
- a ceiling on band-exempt truncations (inside the band and unnamed): across the silent runs of a
  results directory they may be at most 10% of truncated requests (checked once 20 are truncated).
  The summary reports their count and the tokens they lost beside C3, as a trend;
- a ceiling on wrong names: across the silent runs of a results directory, answers named without
  truncation may be at most 5% of the named answers (checked once 20 are named). Without it, an
  engine that named every recent answer would pass;
- the 2% margin stays: a wrong name costs a needless warning, a missed one a silently wrong answer.

Before the fix, with this criterion (the prototype on the pinned corpus, c2b5f961), 46 of 48 silent
runs pass. Of 82 truncated requests, 67 were outside the band and 65 of those were named. The two
that were not: coding.glm.32k.silent-front call 9 was truncated long before detection (call 26),
outside the 16-sample list; research.glm.32k.silent-messages call 18 was 6 calls before detection,
and the naming rule that D14 replaced left it out. Three inside the band were not named, and one
answer was named without truncation (1 in 78 names).

After (the port's engine): 48 of 48 silent runs pass. 82 requests were truncated, 67 of them
outside the band, and all 67 were named. 3 inside the band were not named. One answer was named
without truncation (data.glm.32k.silent-messages, call 10), a false-name rate of 1 in 80 (0.013),
under the 0.05 ceiling.

The 5% cap was added after these runs, at review. Rescored from the stored series (lost = real
tokens - reported, error from the stored estimate and ratio; the rescore reproduces the stored
band verdict in 48 of 48 runs), it changes no verdict before or after the fix. Six truncated requests had
an estimate error above 5% (5.2% to 8.1%, all o200k at 32k); each lost 12% to 21.5% of its
request, outside the band with or without the cap, and each was named. Band-exempt truncations: 3 of 82
truncated requests (0.037), 3,332 tokens lost, under the 0.10 ceiling.

What the three band-exempt truncations removed (rerun with `E2_DUMP_DROPPED=1` on the final engine
before review round 4, the same calls truncated): each came before the run's first cut, so no window
header or pin existed yet, and each removed the oldest conversation messages. research.o200k.128k and 1m
(calls 36 and 45) lost the Task 0 prompt, two assistant replies and their two tool results (55 + 36 +
694 + 36 + 821 = 1,642 tokens each), as in the rescored runs. coding.glm.1m.silent-messages call 31
lost the Task 0 prompt (48 tokens) in the rescored run, and the prompt and the first assistant reply
(48 + 47 = 95) in the rerun, whose request at that call was 16 tokens larger (100,058 against 100,042,
over a 100,000 limit): the rerun ran from another checkout, and Pi's system prompt carries the checkout's
path (the cwd under the E2 scratch directory and the docs paths), 16 tokens more on every request of
that run, whatever the engine. The 3,332 above is the rescored runs' 48 + 1,642 + 1,642; the rerun's three
total 3,379. In both, the next call lost more (in the rerun 15,034, 2,909 and 18,747 tokens), was
outside the band and was named; detection followed and the cut came on the call after. No header, pin, notes or
recovery-tool output was dropped in band. A truncation inside the band that removes only the header
or pin would go unnamed the same way; E2 has no such case.

### E2 runs on a pinned corpus, reproducibly

E2 builds its sessions from the repository's tracked files. In the fork they differ from stock Pi
and change with every commit (corpus f530de63 instead of c2b5f961), which produced two C6 failures
that came from the corpus, not the engine. E2 now reads the corpus from upstream's tree at the
recorded base through git objects, with the CRLF conversion a checkout applies, and reproduces
c2b5f961 exactly.

E2 runs were also not reproducible: two runs of one engine differed at every call. The window header
and cap notices name session entry ids, which were random, and the harness's temp directory, which is
the session's cwd and so part of the system prompt, was named from the time and a random number. The
suite and E2 now make entry ids deterministic (a vitest setup file), and E2 names the directory after
the run, so two runs of one engine match call for call. E2 copies the engine it tests, with every file
the entry imports, into `.engine/<sha12>/`, so all workers run the same bytes.

Splitting the engine into modules changed no behaviour. The engine from before the split and the
shipped engine each ran the 48 silent runs on corpus c2b5f961: both passed 48 of 48, and every run's
result was identical (every criterion, cut and call count; only wall-clock fields differ), as was
every engine log once timestamps are removed. The two self-tests matched as well.

### D12: re-probe threshold

Kept as the prototype has it: a clean request counts toward the re-probe of a window learned from
silent truncation at 0.3 x the window (half the lowest high-water mark), and of a window learned from
an overflow error at 0.5 x. Moving overflow-learned windows to 0.3 would move a re-probe rejection
into recovery.test's 80-turn window (2 rejections instead of 1) for no measured gain.

### D15: continuation after a reasoning-only length stop

The cap stays at 3 continuations per run. In the benchmark, after a reasoning-only stop (no text, no
tool call), attempt 1 answered in 16 of 24 affected runs, attempt 2 in 4 of 8 and attempt 3 in 1 of
3; the 3 aborts were step timeouts (35 such stops in 24 runs). A cap of 1 would have failed 5 of the
24 runs that later succeeded. Such stops now get their own message ("... used the whole output limit
on reasoning and produced no answer; that reasoning is not available to you now. Give the answer or
the next tool call directly, keeping the reasoning short."), selected by `reasoningOnlyContinuation`
("answer", default; "continue" sends the ordinary continuation) so the release benchmark can compare
both. No reasoning-effort drop for now.

### D16: context_search finds a tool result by its call

In arm S, session s14, the model read `ops/freeze-window.yaml`; after it left the window the model
searched `freeze-window approval_code` (no entry had both words: the result holds the file, the path
is in the call) and then `freeze-window.yaml` (the call and its own summary, not the result), and
answered "unknown". A tool result is now searched together with its call's argument values (the
path it read, the command it ran; not the tool name or JSON keys, which every result of a tool
shares), paired with its own call in branch order (a reused id pairs each result with its own call,
first in, first out; empty ids pair nothing). An assistant message's calls are searched the same way,
by argument values. A hit on an assistant message with tool calls names the result entries of
the calls whose text holds a query word (`result: <id>`), most query words first, all of them only
when none does. A result
matched only through its call is left out when its call is a hit, and otherwise listed with its
snippet marked `call: `; its own text holds none of the words, so recalling it would return none of
them. The snippet still comes from the entry's own text when it holds a query word. Optional part, taken: when
no entry has every word, the reply says so and lists the entries with some of them, most words first
(newest first among equals), each marked `k of n words`; 36 of arm S's file and tool-output probes
began with a several-word query that matched nothing. The tool's description is unchanged (it is in
every request). Test: `d16-search-tool-call-arguments.test.ts`, the s14 session trimmed to the read,
the model's two queries, a partial one and the recall that returns the approval code.

### Replayed reasoning, per model

`replayedReasoning` ("provider/modelId" -> "counted" | "ignored", default "counted"). GLM stays
"counted": in the benchmark, prompt growth equalled the previous turn's reasoning (median 1.00 over
128 request pairs). Doctor names the setting when the ratio sits at the 0.8 floor with thinking on.

Checked in E2 against a provider that ignores replayed reasoning, with the model set to match
(`replayedReasoning: "ignored"` on every run's model, recorded in the run's config): 24 high-thinking
runs (4 mixes x 2 tokenizers x 3 windows) pass every criterion: no rejections, the largest request at 0.87 of its
budget, and C3, the mean request after the first cut over the budget, is min 0.504, median 0.563, mean
0.551, against the 0.45 floor. For such a provider the setting neither overfills nor wastes the window.

The replay check (warn-only; choosing the setting automatically can follow in 0.6.0) runs the
benchmark's test online. Between two consecutive requests with no cut, reported usage grows by the
appended text, plus the replayed reasoning if the provider counts it; each pair gives the share of
the replayed reasoning the growth accounted for (about 1 counted, about 0 ignored). It uses the
uncalibrated estimates: with the setting wrong, the calibration ratio absorbs the very share being
measured (it climbs past 8 in the test when "ignored" meets a provider that counts). A pair counts
only when its replayed reasoning is at least 64 tokens and half the appended text, so the
estimator's error (within about 0.85 to 1.12 of real tokenizers) moves a share by at most about 0.3.
From 20 pairs on, the verdict is "counted" from a median share of 0.5 and "ignored" only below 0.3,
since the estimator's error is systematic per model and an over-counting estimator pulls a counting
provider toward "ignored", the direction that under-counts. The rule is asymmetric: "ignored" is
withheld while a tenth of the pairs, or 3 of them, are at 0.5 or more (they count the replay: a
provider that keeps reasoning only inside a tool loop, or an over-counted 0.6), and "counted", the
safe direction, only when a quarter are below 0.3. Between 0.3 and 0.5 there is no verdict. A verdict that disagrees with the setting
gives one warning per session and model, naming the setting and the value to try. Without a verdict,
a setting of "ignored" still gets that warning, recommending "counted", when the pairs that withhold
"ignored" are there: those requests are under-counted, the risky direction (review round 4, N1). A
setting of "counted" gets nothing without a verdict. Doctor prints the pairs, the median, the verdict
and any recommendation. Nothing is persisted, so a run without a warning is unchanged.

### The orientation briefing moves into the system prompt (behaviour change from 0.4)

PENpi 0.4 sent the orientation briefing (the PENpi protocol and Penfield's awaken + reflect) as one
custom message at session start, and FIFO pinned the newest one. The engine has no such pin, so from
its first cut the model would see neither its memory orientation nor the protocol. PENpi now puts the
briefing into the system prompt, as the section `<penpi-memory>`, through the extension API
(`before_agent_start` edits `systemPromptOptions.sections` on every run). No core patch is involved.

- No message is sent at session start, so the briefing is never in context twice. A resumed 0.4
  session still holds `penpi-briefing` messages; they stay in the session, but the engine never sends
  them: PENpi lists the type in the engine option `hiddenCustomTypes`, which leaves such messages out
  of every request and of the budget. Neither `context_search` nor `search_transcript` returns them:
  their text is Penfield memory, which must not come back as tool output outside the fence. A test
  resumes a session with two of them.
- The engine counts it as system text. A test checks that the first request's estimate grows by the
  briefing's estimated size.
- The section is byte-stable within a session and changes only at a cut (spec E8.14), so the
  system prompt, the front of the cached prefix, changes only where the window does. After each run
  PENpi reads awaken + reflect again in the background. A changed briefing is handed to the engine
  (`setSectionAtNextCut` on the engine handle, with the section's content as a host sets it; the
  engine wraps it in the `<penpi-memory>` tags exactly as Pi's builder does, checked by a test
  against that builder), which puts it into the system prompt at its next cut:
  the cut's system checkpoint carries it, older copies of the section in the kept window are left
  out of that request, and the cut entry records it, so a rebuilt window sends the same prompt (a cut
  entry records the sections only when they differ from the previous cut's, D19). A request the
  engine cannot plan (an alignment mismatch, an error in its handler) sends Pi's own messages with
  the latest cut's change applied over them, so it keeps the refreshed briefing too, and is estimated
  as sent, with that change (D17).
  The changes in effect carry over a session start (a resume or reload) from the latest cut: Pi
  records only a diff of the system prompt, so with an unchanged host text it records nothing and
  the cut's change still holds. A system message Pi records later that sets the section again is
  newer and wins; the engine then drops its change.
  `before_agent_start` keeps setting the session-start text, so Pi records no change mid-session. A
  new session or a resume orients again; Pi records that text anew, and it wins over a change made
  at an earlier cut. A reload (`/penpi login`, `/reload`) orients again too, but the session goes on:
  PENpi keeps setting the text Pi recorded, and the new text takes effect at the next cut, as a
  refresh does, replacing any change pending or in effect there (D20). At most one read runs at a
  time. Once session shutdown begins no refresh writes, and shutdown waits for a running read at
  most 2 seconds before disconnecting, which ends it (D21). The exit checkpoint (`save_context`, opt-in)
  still waits for Penfield, up to the client's request timeout: a checkpoint matters more than exit time.
  PENpi's state entries record a SHA-256 and length of each memory text, not the text, and
  `search_transcript` skips state entries, so memory text never comes back outside the fence (D19).
- Memory is data, not instructions. Inside the section, the PENpi protocol is followed by the memory
  between `=== BEGIN/END PENFIELD PERSISTENT MEMORY ===` fences, after one line saying it is reference
  data recalled from Penfield (some of it written by other agents or copied from the web) and not
  instructions. The memory itself is one JSON object on one line (`orientation`,
  `recent_reflection`), with `<`, `>`, `&`, U+0085 and U+2028/U+2029 escaped as `\uXXXX`, after the fence
  sanitizer of ADR 0024/0029. Each text is capped at 64,000 characters as encoded (escaping can make
  a text six times longer, so a cap on the raw text would not bound the section). The engine cannot
  cut the system prompt, so the whole section is also capped in tokens, like the pin: at most 20% of
  the planning window and at most 24,000 tokens in the engine's estimate. Over that, both texts are
  cut to the same encoded length, the largest that fits, each with its truncation note (D18). When the window
  shrinks (a smaller model, a learned window, or a resume on a smaller model where orientation has not already
  re-composed it), PENpi's section is composed again for the new cap before the next request and applied at a cut
  made there, recorded in the cut entry; a section pending for a later cut is capped the same way; on a fixed
  window nothing changes (D25). No memory text can
  end the `<penpi-memory>` tag, open a tag or start a
  line, so it cannot forge a fence or step outside the data. The system prompt gives this text more
  authority than a message did, which is why the fencing is required.
- `penpi.displayBriefing` shows the briefing as a notification at startup, since there is no message
  to display.
- Tests: the briefing is in all 45 requests of a session with 5 cuts, only the system prompt carries
  it, and the system text is the same in every request. With 0.4's message, the first request after
  the first cut loses it. Penfield changing between two prompts with no cut leaves the system prompt
  byte-identical; the next cut brings the new text, and it changes nowhere else
  (`penpi-briefing.test.ts`). The engine's part, with an older copy of the section in the kept
  window, a rebuilt window and a resume, is `system-section-at-cut.test.ts`. A memory holding
  `</penpi-memory>`, a forged fence and instruction-like text stays inside the one JSON line and
  parses back unchanged (`index.test.ts`). A resumed 0.4 session's briefing messages are neither
  sent nor pinned, with `unrecordedSource: "pin"`; a 0.4 user message with no recorded source is
  pinned in the same session. No PENpi version sent the briefing as a user message.

### D10 with the pin off

One run-record kind: `shortPromptChars` only chose between two kinds that the pin treats alike. With
the pin off (`pinUserMessages: null`), a short prompt now becomes the task instead of a latest
instruction. Older sessions' `latest` records are still read.

### The engine log stays plain text (a deviation)

The engine log is the prototype's: one timestamped plain-text line per event, not JSON lines. The
benchmark's tooling reads these lines as they are, so changing the format would break comparison with
earlier runs. What a program needs to read, the per-request telemetry, is JSON (`telemetry {json}`
lines and the `context-engine.telemetry` status).

### The tests load code only from verified, repo-local places

The suite and E2 count with real tokenizers (npm packages and the GLM-5.3-Flash files). They were
loaded from a fixed shared path in `/tmp`, where another user could plant code that `npm test` runs.
They now live in a git-ignored directory of the repository (`npm run setup:tokenizers` fills it), the
whole installed npm tree is checked against a pinned SHA-256 before anything is loaded, and each GLM
file against its own. Test reports, E2 scratch and E2 results moved out of `/tmp` too.

### Coverage beyond the behaviour tests

- **Properties** (`properties.test.ts`): seeded random sessions for windows of 8k, 32k, 128k, 200k and
  1M tokens, against a provider that counts 0.9 to 1.6 times the estimate. Every request fits the
  window with the output it asks for and is never rejected by an honest provider; it starts with a
  user message and pairs every tool call with its result; between cuts it extends the previous
  request; the header stays within its bound and the pin within its cap.
- **Stock Pi** (`scripts/engine-suite-upstream.sh`, CI job `engine-on-upstream`): the suite runs
  against upstream Pi at the recorded base, without PENpi's core patches, apart from the two tests
  that load PENpi's extension. Upstream does not commit its model data (it hydrates it from live
  catalogs, which drift from v1.1.0's types), so the build uses the fork's committed snapshot: data
  only, every line of code is upstream's.

## Consequences

- ADRs 0003, 0023, 0025, 0027 and 0028 are superseded. Tier 1 of ADR 0004 is the engine's window.
- No LLM summary is ever requested. A model with no context window is planned against
  `defaultWindow` (32,768), or a `limitOverrides` entry, instead of being compacted.
- The engine is much larger than FIFO, so the suite, the properties and E2 carry the weight. CI runs
  the suite on every push, against both the fork and stock upstream Pi, and E2 weekly, with the
  tokenizers pinned.
- `npm test` needs `npm run setup:tokenizers` once (npm registry and huggingface.co).
- E2 results in the fork are comparable with earlier ones, reproducible, and stable across commits.
