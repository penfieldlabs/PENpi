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

- **The residual risk is one honest marginal sample and one honest evidence sample within 30 samples.** In the replay,
  honest marginal samples were rare (8 in 720 sessions, all `+`-bar outputs at 32k), and the one honest evidence
  sample had none near it. Neither the replay nor E2 has much repetitive output (runs of one character and the like),
  so that rate understated the risk (below). Such a false detection learns a window from the largest usage reported,
  for that session only. A window below a quarter of the planning window is re-probed, and `/penpi reset-limits`
  clears it.
- **What the outside review of 0.8.0 found.** `textTokens` charges every punctuation character, and tokenizers
  merge a run of one character: 2,000 dots are 1,285 tokens by the estimate and 32 with o200k and GLM-5.3-Flash.
  Honest tool output made of such runs (test dot reporters, rules, progress bars, the bars of `git diff --stat`,
  padded table rules) then reads as most of the append missing. On an honest provider counted with o200k, four
  ordinary sessions detected silent truncation, cut the context and named answers:
  - one unittest run of 2,000 tests (strong evidence alone), and a run of 600 tests twice in the span (two evidence
    samples). 0.7.0 detects both: they date from before this ADR.
  - `git diff --stat` (marginal), then one 600-test run (evidence): a pair under this ADR.
  - a 600-test run before a cut and again after it: the second is far below the largest usage reported, so it cannot
    be evidence (the 0.8 size guard), but it was marginal and completed the pair. That gap came with this ADR.
- **What a second review of 0.8.0 found.** A floor for runs of one character is not enough. `textTokens` overcounts
  other honest output four to six times: base64 of a zero-filled file (2,677 tokens by the estimate, 500 with o200k
  and GLM), `-=-=` rules (2,738 and 420), lines of one letter (2,849 and 659). Reading either of the first two twice
  in a long session detected silent truncation on an honest provider, on 0.7.0 and with the run floor alike.
- **What a later review found: whitespace with a period of two.** Whitespace that repeats with a period of two escaped
  every arm: 1,500 blank CRLF lines read 0.19 of the floor in real tokens, lines of one tab 0.19, lines of one space
  0.38. Blank CRLF lines read twice in a long session detected silent truncation on an honest provider.
- **What a later review found: whitespace with no period.** Whitespace that holds a line break still escaped where it
  has no period the arm could see: blank stretches shorter than its 32-unit minimum between short lines, periods of 11
  to 24, and aperiodic whitespace (blank lines of random count, random trailing spaces). A counter line, then 7 blank
  CRLF lines, 400 times, read 0.239 of the floor and, read twice, detected silent truncation on an honest provider.
- **What a later review found: marker lines and non-ASCII runs.** Two kinds of honest text read between 0.25 and 0.5 of
  the floor. Lines of only a comment marker between blank lines (`//` lines, 0.454): o200k takes the marker with the
  breaks after it, and the arm for line breaks priced only the whitespace. Runs of a non-ASCII character between breaks
  (`…`, `—`, 0.485): only the run arm priced them, as a separate term of the least. Neither detected end to end.
- **Honest shapes left in the marginal band.** Honest text in three shapes still reads between 0.25
  and 0.5 of the floor: a marker after text on the same line (a counter, a space and `-->`, `*/` or `//`, then 1 to 3
  breaks; 0.343 the lowest), lines of a marker of two or more words between blank lines (`// //`, `// *`,
  `// // // //`; 0.420), and closing brackets or markers before a break and the next line's indentation (`});`, `-->`,
  `],`, `*/`, before 0 to 60 spaces; 0.422). None detects end to end. Widening the marker piece to take them was
  measured and undone. It closed the sweep's cases, but lowered the floor of ordinary output by 4.3% over 47 files, of
  nested pretty-printed JSON by 14 to 20% and of source code by up to 8.4%, since nearly every line of nested JSON ends
  in such a marker before indentation; taken only when the next line holds no letter, by 1.1% and 9 to 10%. Neither
  closed the deepest cases (`});` or `-->` before 40 to 60 spaces, 0.490; four-word marker lines). A marginal sample
  never detects alone or with another marginal one; it counts only with an evidence sample. So these shapes are left in
  the marginal band, written down, and the floor keeps its strength on ordinary output.
- **The fixes, in 0.8.0:**
  - The growth check judges the shortfall against a floor of the appended text (`textTokensFloor`;
    `messageFloorSlack` is the difference per message), the least of:
    - `textTokens`;
    - `textTokens` with a run of 4 or more of one character that is not a letter, digit, space or tab at 1 +
      length / 64;
    - the class costs without `textTokens`' lower bound of length / 8 (text that is mostly spaces);
    - `textTokens` with its repeatable segments, runs of 48 or more base64 characters and runs of 8 or more ASCII
      punctuation, at 2 tokens per byte of those segments deflated, when that is less than their price;
    - the text with its runs of a short period at a floor of their own, and the rest as the segment arm prices it. A
      run has a period of 1 to 10 characters (a unit of up to 8 and its CRLF), is 32 or more long and holds 4 or
      more periods; runs only of letters, only of digits or only of spaces and tabs are left to the other arms.
      Within one character class (whitespace, letters, digits, other) a run costs 1 + length / 64, as a run of one
      character; across classes, half a token per change of class in each period, since a tokenizer merges over at
      most one change (o200k keeps punctuation and the newlines after it together);
    - as the last, and with each run of whitespace that holds a line break at 1.25 + length / 16, of any length and
      mix and with no period needed, except one break and the indentation after it (how ordinary text starts a line,
      which `textTokens` prices near its count). Tokenizers split such a run into one or a few pieces and merge
      repeated breaks. They also take what ends a line with the breaks after it (o200k keeps punctuation and the
      newlines after it together), so in this arm a run of 4 or more of one character, as above, that only spaces
      or tabs and a line break follow costs 1 + length / 64, and a marker of 1 to 3 UTF-16 code units that are not
      letters, digits or whitespace, at the start of a line with no indentation, costs 1.25 + length / 16 together
      with the whitespace after it, when that holds a line break (`//` comment lines, `>` quote lines, `|` table
      edges). Indented markers stay out, so the closing brackets of nested code and JSON keep their price.

    The appended size in the log, the ratio and the learned window are unchanged.
  - The pair's marginal side has the evidence side's size guard (`meetsSizeGuard`): a marginal sample expected below
    0.8 of the largest usage reported is not kept for a pair. It still cannot clear evidence.

  Why a bound on deflated segments: real tokens over the floor should stay at 0.5 or more for honest text, and must
  never fall below 0.25, or an honest append reads as evidence. Between the two it reads marginal (the shapes above).
  Measured with o200k and GLM-5.3-Flash on 121 samples of honest tool output (the reviews' cases, runs and short
  patterns, base64 and hex of zero, sparse and random data, lockfiles, minified code, JSON of hashes, CSV, logs, CJK,
  emoji, tables, source code, E2's own classes) and 246 of sparse binary data, the lowest is 0.61 (base64 of data with
  10% of bytes set); with `textTokens` alone, 32 of the 121 fall below 0.5, and with the run floor alone, 19. A run
  floor generalised to short periods does not reach base64 of sparse data, and a bound on the whole text deflated also
  takes repetition across lines, which tokenizers do not merge: on E2's whitespace-heavy output no constant served
  both. The segments are the text `textTokens` prices character by character. The arm for short periods covers what
  neither reaches: whitespace and control characters, which are neither base64 nor punctuation, and periods that
  alternate classes.

  The floor sweep (`floor-sweep.test.ts`, seeded, so it reruns) checks the floor against both tokenizers, 24,321 cases:
  - every period of 1 to 8 drawn from all ASCII characters and common non-ASCII ones (box drawing, block elements,
    emoji, CJK, combining marks), and periods of 9 to 32 drawn mostly from whitespace and control characters, 714
    units, each at 1,000, 10,000 and 100,000 characters in five layouts (alone, one per line with LF or CRLF, numbered
    lines, timestamped CRLF lines);
  - whitespace stretches of every length from 1 to 64 code units, in 12 mixes of space, tab, CR, LF, NBSP, other
    Unicode spaces, VT and FF, periodic and random, after counter lines and after text lines of 1 to 80 characters;
    and lines with random trailing whitespace, random indentation and random blank-line counts;
  - lines of only one of 31 markers (`//`, `#`, `>`, `*`, `|`, `--`, `;`, `%` and others), with no, one or 0 to 3
    trailing spaces, between 0 to 8 random blank lines, LF and CRLF; and runs of every length from 1 to 64 of 22
    non-ASCII characters (ellipsis, dashes, box drawing, block elements, dots, CJK, emoji) followed by random spaces
    or tabs and 1 to 7 breaks;
  - markers after text on the same line (counters, timestamps, words, code) after a space or a tab, then 1 to 3 or 1 to
    8 breaks; markers of 1 to 8 characters composed of the 31 markers with or without spaces between, or drawn from
    punctuation and symbols; markers with 16 short punctuation or symbol texts after them, with or without a space; and
    14 markers and closing brackets each followed by a break and 0 to 8, 8 to 40 or 0 to 40 spaces, tabs or both, so
    that the next one is indented (3,672 cases);
  - every case named above, the reviews' measured cases, with their sessions, and the sparse-data samples.

  On the floor before the arm for line breaks, 327 cases were below 0.5, the lowest 0.214 (26 CRLF units after counter
  lines); the sweep found on its own the 0.239 case a review had measured. Two candidates were measured. The arm for
  line breaks, fitted on the sweep, closes every case and changes the floor of 53 of 385 E2 samples, by 3.0% at most
  (whitespace-heavy output, then code); counting every run with a break, one break and its indentation included, it
  changes 143 to 153, by up to 12%. A backstop from the whole text deflated (level 1) does not close the cases at any
  constant: at 1.5 tokens per byte 54 stay below 0.5 and 64 E2 samples drop by up to 70%; at 5, where it changes one E2
  sample, 294 stay below. It takes repetition across lines, which tokenizers do not merge. With the marker lines and
  non-ASCII runs added, 38 of the 4,917 new cases were below 0.5 on that floor, none below 0.25, the lowest 0.364 (`─`
  runs of 16 between CRLF breaks). Pricing the run or marker of a line with its breaks closes all of them and changes
  the floor of 71 of 385 E2 samples, by 1.1% at most (top-level closing brackets in code and JSON). Measured against
  it: pricing every run inside the arm, not only one before a break, changes 49 samples by up to 17.6% (`├──` tree
  lines); taking indented markers too, 76 by up to 11.6%; markers of up to 64, 79 by up to 2.7%; the run or the marker
  alone leaves 23 or 15 cases below 0.5. Of the sweep's cases then, none was below; the lowest was 0.501. With the
  marker places and the reviews' later measured cases added (3,672 and 396), 73 cases are between 0.25 and 0.5 and none
  below 0.25, the lowest 0.343, with `FLOOR_SWEEP_FULL=1` too: the three shapes above. The sweep fails on any case
  below 0.25, on a new case below 0.5 (more than 73) or on a lowest below 0.343. A known shape can still go lower
  inside the band without failing: the rule pins the count and the lowest, not each case. The engine suite runs the
  sweep with the periodic cases at 1,000 and 10,000 characters; `FLOOR_SWEEP_FULL=1` adds 100,000. This is what was
  measured, not a bound for every text. The floor costs, once per message, on a 1 MB append about 260 ms of source
  code, 160 ms of pretty-printed JSON, 250 ms of one character, 220 ms of blank lines with random trailing spaces, 340
  ms of `//` comment lines, 290 ms of box-drawing runs between breaks and 405 ms of `});` lines before indentation;
  `//` lines and `});` lines are the costliest measured, about 340 to 410 ms; a slower machine took about 1.4 times as
  long, about 570 ms.

  Where the floor is lower, the check is weaker there, never falser: a lower floor only raises the growth the check
  accepts; it never makes a detection. Runs of one character before a break are judged at about half their real tokens
  (ellipsis runs between blank CRLF lines: a floor of 515 against 1,025 real). On 47 files of ordinary output (source,
  JSON, Markdown, diffs, logs, `git log`, `ls -laR`, grep, HTML) the floor is 0.1% lower than with the arm for line
  breaks alone, and nested JSON's not at all.

  Measured: `honest-provider.test.ts` passes 27 of 27 (13 of 14 on the floor before the arm for line breaks: the
  counter lines with 7 blank CRLF lines, read twice, take the window to 100,592). E2 on the pinned corpus
  (`dd30101cf`): all 96 runs identical with the run floor to the engine without the fixes, and identical again with
  the repetition bound added, with the arm for short periods, with the arm for line breaks and with the run or marker
  of a line priced with its breaks, in every result field and every engine log line (timestamps aside), so the 48
  silent runs keep their truncated calls, detection, lag, names and cuts; the two known failures are unchanged. E2's
  honest runs have no marginal or evidence sample at all, which is why it could not see this. - **Left for 0.9.0:** -
  `textTokens` itself. It still budgets runs and other repetition at the overcount (1,285 tokens for 32), which is
  safe for fit and wastes window. - Repetition across lines. The segment bound deflates all of a message's segments
  together, so the same 64-character hash on 100 lines has a floor of 240 against 3,599 real tokens. That only weakens
  detection for such appends; it never causes a false one. - The provider-switch path (D24). It judges the span since
  the new provider's own last sample as a chain sum, which keeps no floor, so it is judged against the estimate as
  before. - Strong evidence does not join marginal samples, as the outside review also noted. A marginal sample joins
  a weak evidence sample, but a strong one acts alone; the ratio restored and the names then depend on D14 catching
  the marginal sample. No change in 0.8.0. - **Detection with marginal samples first restores the ratio from before
  them.** The marginal samples entered the calibration ratio when judged, like any clean sample. - **Tests:**
  `v080-marginal-pair.test.ts` (each order detects; two marginal samples do not; a clean sample above the maximum in
  between forgets the marginal one; the rule off detects nothing), `honest-provider.test.ts` (the four sessions above,
  the two of the second review and a control, on an honest provider counted with o200k: no detection), and the unit
  tests (`completesMarginalPair`, `clearsMarginals`, `meetsSizeGuard`; `textTokensFloor` and `messageFloorSlack` in
  `engine/estimator.test.ts`).
