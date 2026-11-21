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
- **Prose in other scripts.** `textTokens` prices every letter outside ASCII and CJK at the price of an unknown
  character (`DENSITY.other`, 0.7154, against 0.0739 for an ASCII letter), and no arm of the floor covered prose, so
  the floor of prose was its estimate. Ordinary Russian prose read about 0.3 of it in real tokens (0.27 to 0.37), Hindi,
  Bulgarian and Arabic 0.38 to 0.45 with o200k. The growth check judges the floor times the session ratio, and repository
  exploration output (search hits and file listings) calibrates that ratio to about 1.2 to 1.35. At that ratio a
  Russian document read as evidence: on an honest provider counted with o200k or GLM, two Russian documents after such
  output detected (0.7.0 too), and a Russian document then a Bulgarian one detected as an evidence sample and a
  marginal one, a pair this ADR made. The floor now prices letters and marks (`\p{L}`, `\p{M}`) outside ASCII and
  CJK at `DENSITY.letter`, in every arm, and `textTokens` itself is among its terms, so it is never above the estimate.
  `textTokens` is unchanged, so budgets and calibration are too. Measured against the floor before: never higher on
  the 24,321 cases of the sweep, 20 documents in 13 languages and E2's 385 samples; equal on all ASCII-only text; lower
  on 219 of the default sweep's 20,751 cases (letters of other scripts, combining marks), by up to 86% there (zalgo
  combining stacks, 2,777 to 387), and on 19 of E2's samples, by 0.6% at most there. Prose in each script reads 0.85
  or more of the floor with o200k and GLM (Korean, priced as CJK, is unchanged at 0.85). The cost: for text in these
  scripts the check is less sensitive, since a truncation must cut a larger share to show; one that leaves growth near
  zero still does. E2 has no text in these scripts, so detection lag on a truncating provider in such a session is not
  measured.
- **The session ratio, at most 1, for the floor.** The growth check judged an append's floor times the session ratio.
  The floor prices text near what tokenizers count, so a session ratio above 1 inflated it: repository listings and
  search output lift the ratio to 1.2 to 1.35, and source maps to about 3. The sweep's lowest case reads 0.343 of the
  floor, and at a ratio of 1.34 the evidence line is 0.335 of it, a margin of 0.008; at 3.1, 1,580 of the default
  sweep's 20,751 cases read as evidence. The floor's judged growth now takes the ratio at most 1; a ratio below 1
  still applies. At a provider switch the span takes the floor and the cap too (next item). The sweep now reads
  the same at every ratio: at 1.0, 1.1, 1.2, 1.3, 1.34 and 3.1, 73 cases below 0.5 and none below 0.25, as at 1.
  `honest-ratio-cap.test.ts` lifts the ratio to about 2.9 with source maps on an honest provider, then appends the
  sweep's lowest shapes: no detection, where the full ratio detected (o200k at the first append, strong; GLM at the
  second) and learned a window of about 110,000 tokens. The trade: where the estimate undercounts ordinary text, the
  check is that much less sensitive. On a provider that counts 1.3 times the estimate, a truncation must leave growth
  below about 0.19 of the honest growth to be evidence, not 0.25, and below about 0.115 to be strong:
  `b13-quarantine-ratio.test.ts` reported a fifth of the honest growth, which now reads 0.26 (marginal), and reports
  0.15 now. On E2 (`dd30101cf`), 94 of the 96 runs are identical in every result field and engine log line, and the
  48 silent runs keep their truncated calls, detection, lag, names and cuts. Two GLM runs at 1m differ in a sample:
  in `data.glm.1m.silent-front` a sample with 13,621 tokens appended and +3,209 reported was evidence and is now
  marginal, and the next sample (+0, strong) detects at the same call, with the plateau's expected value and two cut
  entry ids shifted; in `research.glm.1m.silent-messages` a marginal sample (4,335 appended, +2,010 reported) is gone.
  Three more effects. The size gates take the capped value too: an append is judged only when its judged growth is
  256 or more and strong only at 1,000 or more, so at a ratio R above 1 its floor must reach 256 and 1,000 where
  before 256 / R and 1,000 / R were enough; at 1.3, strong needs an append about 1.3 times larger. At higher ratios
  the trade is larger: at 2.9, an append the estimate undercounts as much as the context must keep less than about
  0.086 of its honest growth to be evidence and less than about 0.052 to be strong. Growth near zero (judged on the
  full ratio), the exact-repeat rule and the plateau still detect as before. And a sample that was evidence and is
  now marginal is not quarantined, so it enters the ratio: that is why the expected value moved in
  `data.glm.1m.silent-front`. A strong detection takes it back out only when D14 names it, as there: it reported the
  same count as the strong sample, and every ratio after detection is as before. Otherwise it stays in the ratio, as
  strong evidence does not join marginal samples (left for 0.9.0, below).
- **A provider switch judges the span against the floor.** At a switch (D24) a sample is judged against the serving
  provider's own last sample in the same append chain, and the span between them is a chain sum. The chain kept no
  floor, so the span was judged against the estimate times the full ratio, and everything the floor was built for read
  there as it did before the floor. On two honest providers behind a router, counted with o200k and GLM, a session
  that reads source files and then the dot report of 16,000 passing tests on the second provider detected silent
  truncation at the next sample (10,279 tokens appended, +650 reported, strong) and learned a window of about 69,300;
  so did the same session with the providers alternating on every request. An 8,000-test dot report then base64 of a
  zero-filled file, each on the second provider, read as an evidence sample and a marginal one with o200k (this ADR's
  pair, window about 71,100) and as one strong sample with GLM (5,753 appended, +862, just under 0.15). The counts are
  from one checkout and shift by about 100 tokens a request with the install path, which the system prompt carries; at
  another path, the 8,000-test session can detect with o200k as one strong sample instead of the pair. The chain now
  sums `appendedSlack` beside the text (`appendSlack`), each sent request and each provider's last sample keep that sum,
  and the span is judged as a plain append is: `(span - its slack) * min(ratio, 1)`. The notice handling at a switch and
  the zero-growth rule are unchanged. The trade: at a switch the check is as sensitive as everywhere else, which for
  repetitive text and at ratios above 1 is less sensitive than before; growth near zero still detects.
  `d24-honest-switch.test.ts` runs those three sessions and three controls (one provider; more source on the second
  provider; more source with the providers alternating) with each tokenizer: no detection. Without the change,
  sessions 1 to 3 detect with both tokenizers. `d24-provider-switch.test.ts` passes unchanged, so truncation at a
  switch is still detected.
- **The fixes, in 0.8.0:**
  - The growth check judges the shortfall against a floor of the appended text (`textTokensFloor`;
    `messageFloorSlack` is the difference per message), the least of the terms below, where every term but the first
    prices letters and marks outside ASCII and CJK at the price of an ASCII letter:
    - `textTokens`, and `textTokens` at that letter price;
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
  the floor of 71 of 385 E2 samples, by 1.1% at most (top-level closing brackets in code and JSON). Measured against it:
  pricing every run inside the arm, not only one before a break, changes 49 samples by up to 17.6% (`├──` tree lines);
  taking indented markers too, 76 by up to 11.6%; markers of up to 64, 79 by up to 2.7%; the run or the marker alone
  leaves 23 or 15 cases below 0.5. Of the sweep's cases then, none was below; the lowest was 0.501. With the marker
  places and the reviews' later measured cases added (3,672 and 396), 73 cases are between 0.25 and 0.5 and none below
  0.25, the lowest 0.343, with `FLOOR_SWEEP_FULL=1` too: the three shapes above. The sweep fails on any case below 0.25,
  on a new case below 0.5 (more than 73, and 54 since the characters Claude drops cost nothing; see below) or on a
  lowest below 0.343. A known shape can still go lower inside the band without failing: the rule pins the count and the
  lowest, not each case. The engine suite runs the sweep with the periodic cases at 1,000 and 10,000 characters;
  `FLOOR_SWEEP_FULL=1` adds 100,000. This is what was measured, not a bound for every text. The floor costs, once per
  message, on a 1 MB append about 260 ms of source code, 160 ms of pretty-printed JSON, 250 ms of one character, 220 ms
  of blank lines with random trailing spaces, 340 ms of `//` comment lines, 290 ms of box-drawing runs between breaks
  and 405 ms of `});` lines before indentation; `//` lines and `});` lines are the costliest measured, about 340 to 410
  ms; a slower machine took about 1.4 times as long, about 570 ms.

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
  honest runs have no marginal or evidence sample at all, which is why it could not see this.
- **The tokenizers the floor is measured against.** The sweep's rule, no honest case below 0.25 of the floor, was first
  checked with o200k and GLM-5.3-Flash alone. It has since been checked with nine public tokenizers from Hugging Face,
  through `@huggingface/tokenizers`: cl100k (`Xenova/gpt-4`), Llama 3.3 (`unsloth/Llama-3.3-70B-Instruct`), MiniMax M2
  (`MiniMaxAI/MiniMax-M2`), DeepSeek V3 (`deepseek-ai/DeepSeek-V3`), Qwen 2.5 (`Qwen/Qwen2.5-7B-Instruct`), Mistral Nemo
  (`unsloth/Mistral-Nemo-Instruct-2407`), Grok-1 (`Xenova/grok-1-tokenizer`), Gemma 3 (`unsloth/gemma-3-4b-it`) and the
  retired Claude 2 (`Xenova/claude-tokenizer`); and with Claude itself, through Anthropic's token counter
  (`POST /v1/messages/count_tokens`) on every Claude model Pi lists. Those fall into four groups that count the sweep
  alike: the 4.5 and 4.6 models; Opus 4.7; Fable 5, Opus 4.8 and Sonnet 5; and Fable 5.1 and 5.2, Haiku 5.5, Opus 5 and
  5.5 and Sonnet 5.5. Real requests bill what the counter counts. Anyone with an Anthropic API key can repeat the count
  with `packages/coding-agent/test/suite/context-engine/floor-sweep-claude.mjs` (its guide, `floor-sweep-claude.md`, is
  beside it). The retired Claude 2 is still the one exception, with its six cases below 0.25: runs of one U+0000, U+00A0
  or U+3000 alone, and lines indented with runs of Unicode spaces, which Claude 2 merges far more tightly than the
  current Claude models: 10,000 of one count 12 on Claude 2, against 625 for U+0000 and U+00A0 and 10,000 for U+3000 on
  the current ones. The fix for the current models does not reach them and was not meant to.
- **Characters Claude drops cost nothing in the floor.** Claude's tokenizers drop the C0 controls but NUL, TAB and LF
  (CR, VT, FF, ESC and the rest), DEL and all 32 C1 controls, measured one by one since the sweep holds no C1 character
  but NEL: 1,000 of one count 0 in every group, and between other text they cost nothing and split nothing. Priced as
  punctuation, they put about 1,360 of the sweep's 24,341 cases below 0.25 with each Claude group, mostly units of
  control characters and runs of CR. The floor is now the lesser of its value for the text and for the text without them
  (`FLOOR_FREE`), so it is never higher than before. Claude also merges runs of NUL with spaces (1,000 NUL count 63),
  and runs of U+2028, U+2029 and Unicode spaces (20 of U+2028 count 2), so NUL is whitespace in a period's classes where
  that gives fewer changes, and a run of whitespace or NUL with no line break, not only spaces and tabs, costs 1.25 +
  length / 16 where that is less than its class costs. That last rule is what lifts the two cases that hold no character
  Claude drops, runs of U+2028 and spaces (0.126 and 0.235 before, 0.984 and 0.524 now). With Claude's counts none of
  the sweep's cases is below 0.25 in any group; 14 (4.5, 4.6 and 4.7) to 51 (the later groups) are below 0.5, the lowest
  0.280 (a line, a break and 30 indents of NBSP and space). With o200k and GLM none is below 0.25 and 54 are below 0.5,
  from 73: the CRLF forms of 19 marginal shapes left the band. The lowest is unchanged at 0.343. The trade: text with
  only LF line ends keeps its floor; a CRLF file's floor is its LF floor, about 5% lower; output with color codes about
  4 to 17% lower and progress lines redrawn with CR 2 to 17% in the samples measured, more where codes or CRs are a
  larger share of the text.
- **A line start indented with Unicode spaces costs as a run of breaks.** The arm for line breaks keeps one break and
  its indentation at its class costs, since `textTokens` prices ordinary indentation near its count. Indentation of
  no-break and ordinary spaces in turn, as HTML writes a run of spaces, costs about 0.7 of a token a character there,
  and tokenizers merge it; below 32 characters the period arm does not take it, and the sweep's random mix hid it.
  Counted with Claude (all 18 models count it alike), lines with 30 such characters read 0.227 of the floor, as the
  outside review predicted from the random mix, and 28 to 31 read 0.220 to 0.242; the random mix reads 0.231, 0.207 and
  0.182 at 45, 60 and 100. Code lines with this indentation read 0.303 to 0.708, and a nested code listing 0.465 to
  0.490. A line start now keeps its class costs only when its indentation is spaces and tabs (`PLAIN_LINE_START`) or
  when those costs are no more than 1.25 + length / 16; otherwise the run costs 1.25 + length / 16 like any run with a
  break. That covers the form at every depth: at 4 characters the floor of such lines drops from 1,693 to 688, at 30
  from 8,819 to 1,338, and from 32 the period arm already took it. All of these now read 1.07 or more with Claude. The
  sweep gains the 15 cases of the review (the form in turn at 16 to 31 characters, either order first, and the random
  mix at 45, 60 and 100). With Claude's counts none of the 24,336 cases is below 0.25 in any group; 12 (the 4.5 and 4.6
  models and Opus 4.7) or 49 (the later ones) are below 0.5, the lowest 0.494 to 0.499. With o200k and GLM nothing
  moves: none below 0.25, 54 below 0.5, the lowest 0.343. The floor is lower on 169 of the 24,336 cases (indentation and
  whitespace stretches that hold Unicode spaces), by 0.1% to 86%, and higher on none; text without Unicode spaces keeps
  its floor. Measured against it: pricing every whitespace run at the lesser of its class costs and the break-run price,
  except plain line starts and runs of spaces and tabs, would read more simply but lowers 3,333 floors and raises 337,
  so it was not taken.
- **Left for 0.9.0:**
  - `textTokens` itself. It still budgets runs and other repetition at the overcount (1,285 tokens for 32), which is
    safe for fit and wastes window. It also prices letters outside ASCII and CJK at the price of an unknown
    character, 2.3 to 3.5 times the real count for Russian prose: such prose needs a session ratio of 0.29 to 0.44
    (o200k and GLM), and the ratio stops at its floor of 0.8, so it never adapts and the planner cuts such text early
    for the whole session. Measured on an honest provider with a 64,000-token window and 90 documents of about 1,000
    real tokens each: after the first cut, a Russian session's requests average 0.22 to 0.24 of the window where
    English averages 0.51, and it is cut 10 or 11 times where English is cut 4. Greek, Arabic, Hebrew and Hindi
    average 0.30 with o200k, and as much as English with GLM, which counts those scripts above the estimate. The cost
    is context kept; detection is unaffected.
  - Repetition across lines. The segment bound deflates all of a message's segments together, so the same 64-character
    hash on 100 lines has a floor of 240 against 3,599 real tokens. That only weakens detection for such appends; it
    never causes a false one.
  - Strong evidence does not join marginal samples, as the outside review also noted. A marginal sample joins a weak
    evidence sample, but a strong one acts alone; the ratio restored and the names then depend on D14 catching the
    marginal sample. No change in 0.8.0.
  - Prose in other scripts in E2's mixes, and whether the growth check should rest on a bound that does not depend on
    character classes, with the repetition arms on top. Each finding above was a class of text the arms missed; the
    last was whole scripts.
- **Detection with marginal samples first restores the ratio from before them.** The marginal samples entered the
  calibration ratio when judged, like any clean sample.
- **Tests:** `v080-marginal-pair.test.ts` (each order detects; two marginal samples do not; a clean sample above the
  maximum in between forgets the marginal one; the rule off detects nothing), `honest-provider.test.ts` (the four
  sessions above, the two of the second review and a control, on an honest provider counted with o200k: no
  detection), `honest-scripts.test.ts` (repository exploration output, then Russian or Bulgarian documents, with o200k
  and GLM: no detection; and prose in 13 languages at 0.5 or more of the floor), `honest-ratio-cap.test.ts` (source
  maps lift the ratio to about 2.9, then the sweep's lowest shapes, with o200k and GLM: no detection),
  `d24-honest-switch.test.ts` (two honest providers behind a router, a dot report or base64 of zeros read across a
  switch, with o200k and GLM: no detection), and the unit tests
  (`completesMarginalPair`, `clearsMarginals`, `meetsSizeGuard`; `textTokensFloor` and `messageFloorSlack` in
  `engine/estimator.test.ts`).
