# E2: the context engine against real tokenizers

E2 runs long, realistic agent sessions through stock Pi v1.1.0 (`AgentSession`, `test/suite/harness.ts`,
the faux provider from `packages/ai/src/providers/faux.ts`) with a context engine installed as an
extension, and puts a provider simulator in front of the faux model that counts every request with a
**real tokenizer** (OpenAI o200k_base, GLM-5.3-Flash) the way a server would: chat template, tool
schemas, images. It measures whether the engine keeps requests inside its budget in real tokens, uses
the window well, keeps the prompt prefix stable between cuts, and notices a provider that truncates
silently (in two styles). No model API, no keys, no paid tokens: every answer comes from a scripted faux
model.

It measures any engine entry file that exports `createContextEngine` and `newStats`: the engine PENpi
ships (`.pi/extensions/penpi/engine/index.ts`, the default) or a prototype's single file.

## Setup

From the repository root, after `npm ci --ignore-scripts` and `npm run build:offline`:

    npm run setup:tokenizers     # = packages/coding-agent/test/suite/context-engine-e2/setup-tokenizers.sh

The engine suite (`../context-engine`, part of `npm test`) uses the same tokenizer directory.

`setup-tokenizers.sh` installs `js-tiktoken` 1.0.21 and `@huggingface/tokenizers` 0.2.0 from
`tok/package-lock.json` into `.cache/tok` (npm registry) and downloads `tokenizer.json`,
`tokenizer_config.json`, `chat_template.jinja` and `processor_config.json` of
[zai-org/GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) into `.cache/hf/GLM-5.3-Flash`,
each checked by SHA-256 (`tokenizer.json` 19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d).
`.cache/` is inside this directory and git-ignored, never a shared path: the installed npm tree is code that
`npm test` loads. Before anything is loaded, `tokenizer-cache.ts` hashes the whole installed tree and compares
it with `tok/install.sha256`, and checks each GLM file's SHA-256; setup removes and reinstalls a tree that
does not match. It is idempotent. `E2_TOK_DIR` and `E2_HF_DIR` move the two directories.

## Run

From `packages/coding-agent`:

    test/suite/context-engine-e2/run-e2.sh                          # the engine PENpi ships
    CONTEXT_ENGINE_BASELINE=1 test/suite/context-engine-e2/run-e2.sh    # the frozen first version (E2_BASELINE_FILE, default
                                                           #   context-engine/reference/r1-context-engine.ts)
    E2_ENGINE=/path/to/engine/index.ts E2_ENGINE_LABEL=mine test/suite/context-engine-e2/run-e2.sh
    node test/suite/context-engine-e2/summarize.mjs .cache/results/revised-<sha12> .cache/results/baseline-<sha12>
                                                           # side-by-side comparison of two result directories

`run-e2.sh` is the single CI entry point: tokenizer setup, engine snapshot, self-test, the 96-run matrix
(4 mixes x 2 tokenizers x 3 windows x {reject, silent-front, silent-messages, reasoning}, 500 turns each),
summary.
Its exit code is 0 only if the self-test passes and every run PASSes; any FAIL, a missing run or a crash
exits non-zero. It needs no provider keys. `.github/workflows/e2-weekly.yml` runs exactly this command
weekly and fails the job on a non-zero exit.

It resolves the engine's entry file once (`E2_ENGINE`, else `CONTEXT_ENGINE_BASELINE=1`, else the
engine PENpi ships, i.e. what `context-engine/engine.ts` loads). `snapshot-engine.ts` copies that file and
every file it reaches through relative imports, byte-for-byte and with their layout, to
`context-engine-e2/.engine/<sha12>/`, and every worker runs on that copy, so the id in the results is exactly what
ran even if a source file is edited meanwhile. The id is the file's SHA-256 for a single-file engine and
the SHA-256 of the snapshot's `MANIFEST` (one `path<TAB>sha256` line per file) for the module engine
(`.pi/extensions/penpi/engine/index.ts`). Running vitest directly
(`npx vitest --run --config test/suite/context-engine-e2/vitest.config.ts`) without `E2_ENGINE` goes through
`context-engine/engine.ts` and checks the id before and after the import.

Narrow the matrix for a quick look (all runs of one mix at 60 turns take about 10 s on 2 cores):

    E2_MIXES=coding E2_WINDOWS=32k E2_TURNS=60 test/suite/context-engine-e2/run-e2.sh

| variable | default | meaning |
|---|---|---|
| `E2_MIXES` | `coding,research,cjk,data` | session mixes |
| `E2_TOKENIZERS` | `o200k,glm` | tokenizer (and with it chat template and image rule) |
| `E2_WINDOWS` | `32k,128k,1m` | model: 32,768/8,192 out; 131,072/16,384; 1,048,576/65,536 (the engine plans 1M within its 200k ceiling) |
| `E2_MODES` | `reject,silent-front,silent-messages` | what the provider does above its hard limit (see below) |
| `E2_TURNS` | `500` | assistant turns per session |
| `E2_SEED` | `1` | plan seed |
| `E2_CORPUS_REV` | the `base:` of `docs/UPSTREAM_PATCHES.txt` | upstream commit the corpus is read from (git objects, as a checkout has them); `worktree` reads the checkout |
| `E2_SILENT_LIMIT` | `half` | silent server context: `half` = min(window, 200k)/2, `window` = the declared window, or a fraction |
| `E2_ENGINE_OPTIONS` | | JSON merged into `createContextEngine` options |
| `E2_DUMP_DROPPED` | | `1`: each silently truncated request's removed segments (role, tokens, first characters) in `<id>.dropped.jsonl` |
| `E2_REASONING_COUNT` | `sent` | reasoning mode: `ignored`, the provider ignores replayed reasoning and the model is set to match (`replayedReasoning: "ignored"`); `misconfigured`, the provider counts it but the model is set to `"ignored"`. Run ids get `-ignored` / `-misconfigured`. Misconfigured runs are reported in their own summary section (C1, C2, rejections, overflow retries, qualifying pairs, median share, warned) and gated only on the warning; the summary fails when one has no replay warning, or any other run has one. Run them at thinking high (`E2_THINKING=high`): at minimal, a run may not reach the 20 qualifying pairs the check needs and then fails for a missing warning |
| `E2_SYSTEM_SECTION_TOKENS` | | a system prompt section (`<penpi-memory>`, set in `before_agent_start` as PENpi sets its briefing) of about this many tokens on every run; run ids get `.section<N>` |
| `E2_PROBE_CONFIRMATIONS` | `2` | C1 allowance per learned limit is 1 + this (the engine's `probeConfirmations` default); `E2_ENGINE_OPTIONS.probeConfirmations` wins |
| `E2_WORKERS` | `2` | parallel vitest workers (one mix file each) |
| `E2_OUT` | `.cache/results/<label>-<sha12>` | results directory |
| `E2_SKIP_SETUP`, `E2_SKIP_SELFTEST` | | skip those steps |
| `E2_ASSERT=0` | | record FAILs without failing the vitest test (the summary still exits 1) |

**Runtime on 2 cores** (`E2_WORKERS=2`, measured on the machine E2 was built on): one `run-e2.sh`
(setup check, self-test, 72 sessions of 500 turns, summary) took **1,051 s** (17.5 min) for the round-5
engine and **1,294 s** (21.6 min) for the round-1 baseline. A single 500-turn session takes 6-19 s for the
coding, research and CJK-with-GLM mixes, 27-107 s for CJK with o200k (js-tiktoken is slow on CJK) and
55-71 s for the data mix (base64 and images). The four mix files run on separate workers, so the wall time
is set by the slowest pair (CJK and data); `E2_WORKERS=4` on a 4-core runner roughly halves it. The
GitHub job allows 90 minutes.

## What a run is

A **session** is 500 planned assistant turns grouped into tasks of 4-30 turns (one user prompt each;
some prompts are short follow-ups, some paste 1.5-5k characters of logs). Every turn but the last of a
task calls one of five tools (`read_file`, `run_command`, `web_fetch`, `take_screenshot`, `write_file`,
real schemas sent with every request) and the tool returns generated content of 1,000-50,000 characters
(log-uniform; median about 7k). Requests rejected by the provider never consume a planned turn.

Content classes (`content.ts`, deterministic in kind, size and seed; real material is taken from files
tracked by git in this checkout, never from the engine's own test directories):

| class | source |
|---|---|
| prose | paragraphs of the repo's Markdown docs, Markdown syntax stripped |
| markup | Markdown sections verbatim, the repo's HTML template, or HTML pages built from the prose |
| code | repo source: TypeScript (tabs, or re-indented to 2 or 4 spaces), Rust (4), YAML (2), C, shell, CSS, HTML, minified JS; 25% with `cat -n` line numbers |
| json / json-min | repo JSON files and GitHub-style API listings, indented (2 or 4) or minified |
| log | app logs, nginx access logs, test runner output with stack traces, syslog, npm |
| table | `ls -l` / `ls -lR` of the repo's files; some `ps aux` and Markdown tables |
| zh, ja | Chinese and Japanese technical prose with inline identifiers, headings, lists |
| base64 | random bytes or slices of the repo's PNGs and WASM, as one line, MIME 76-column, JSON field or PEM |
| whitespace | `kubectl get pods -o wide`-style padded columns, `tree`, 8-space XML, ragged reports |
| image | 1-3 of the repo's PNG screenshots (200x200 to 1720x1116) with a caption |

Mixes (`mixes.ts`, share of tool turns): **coding** code 38%, logs 18%, JSON 12%, minified JSON 5%, tables 8%,
whitespace 5%, prose 5%, `write_file` with 1-8k characters of code 9%; **research** prose 40%, markup 30%,
tables 15%, JSON/code/logs 5% each; **cjk** Chinese 40%, Japanese 30%, code 10%, logs 8%, prose 7%, JSON 5%
(a third of assistant text in Chinese or Japanese); **data** base64 25%, minified JSON 25%, images 20%,
JSON 12%, whitespace 8%, logs 5%, tables 5%.

## The provider simulator

`provider-sim.ts` wraps the session's stream function in front of the faux provider. For every request:

1. Pi's messages are normalized as Pi's `openai-completions` provider does (system messages collapsed into
   one leading system message with the current tools; tool results become `tool` messages; their images
   move into a following user message "Attached image(s) from tool result:").
2. The request is rendered with the tokenizer's chat template and counted (`render.ts`):
   - **o200k** (OpenAI chat format). The ChatML control tokens are not in the public encoder, so framing
     is added as constants from OpenAI's cookbook "How to count tokens with tiktoken": **3 tokens per
     message plus the role name**, **3 tokens priming the reply**. Each **tool call adds 3 tokens plus
     `functions.<name>` and its JSON arguments** (OpenAI publishes no figure; this mirrors the
     per-message rule). Tool schemas are rendered as OpenAI's internal TypeScript `namespace functions`
     block appended to the system message and tokenized.
   - **glm** (GLM-5.3-Flash `chat_template.jinja`, whitespace normalized) is tokenized **including its
     special tokens**, so the overhead is whatever the template adds: `[gMASK]<sop><|system|>Reasoning
     Effort: Max` once (9 tokens), the tools block (`# Tools ... <tools>` with one JSON line per tool),
     `<|system|>` / `<|user|>` 1 token, `<|assistant|><think></think>` 3 tokens, `<tool_call>` /
     `<arg_key>` / `<arg_value>` per call and argument, `<|observation|>` once per run of tool results
     and `<tool_response>...</tool_response>` 2 tokens per result, `<|assistant|><think>` 2 tokens at the end.
     The self-test checks that the per-message counts add up exactly to tokenizing the whole prompt.
   - **Images** per provider: o200k uses OpenAI's high-detail rule (fit in 2048x2048, shortest side to
     768, **85 + 170 per 512-px tile**; 1600x1442 = 765). GLM uses its `processor_config.json` (14-px
     patches merged 2x2 = **one token per 28x28 px**, smart-resized within **16..8,000 tokens**, **+2**
     for `<|begin_of_image|>`/`<|end_of_image|>`; 1600x1442 = 2,966). The engine itself estimates with
     Anthropic's rule (w*h/750, at most 1,600).
3. `usage.input` = that count (no cache split), `usage.output` = the scripted answer counted the same way.
4. Above the hard limit, **reject** mode answers with an error in one of three styles, rotated over the
   runs (`(mix + window + tokenizer) % 3`):
   - anthropic: `Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: Y tokens > X maximum"},...}`
   - openai: `400 This model's maximum context length is X tokens. However, your messages resulted in Y tokens. Please reduce the length of the messages.`
   - none: `Your input exceeds the context window of this model. Please adjust your input and try again.`
   The two **silent** modes answer normally instead, from a truncated request, and report the reduced count
   as `usage.input` (`series.reported` in the results):
   - **silent-front**: token-level front truncation as in Ollama's runner (`inputs[:numKeep] +
     inputs[numKeep+discard:]`, numKeep 4): the system prompt, tool schemas and window header go first;
     usage reports exactly the server's limit, every time.
   - **silent-messages**: whole messages after the system prompt and tool schemas are dropped, oldest
     first, until the rest fits (the newest message always stays); usage reports the real count of what was
     kept, so it varies from request to request and is never "the limit again".
5. The synthetic payload goes through `onPayload`, so the engine's `before_provider_request` hook runs.

**Hard limits.** In reject mode the limit is the model's declared window: an honest provider, so any
rejection means the engine sent more real tokens than the model holds. In both silent modes the server
holds **half of the planning window**, min(window, 200k)/2 = 16,384 / 65,536 / 100,000: a local server
with `num_ctx` below the model's declared window, which is how silent truncation happens in practice.
With an honest window the engine (which plans at most 75% of window minus output reserve) never reaches
the limit and silent mode would test nothing; `E2_SILENT_LIMIT=window` runs that literal variant (with
the round-4 engine all 24 such runs were vacuous: largest request at most 0.72 of the declared window).

## Metrics (per run, `<run>.json`)

- `rejections`: count, late count (call index >= 5), call indices, the first error text, the C1 allowance
  (and whether the engine re-probes, how many limits it learned)
- `largest`: largest request in real tokens, its call, the engine's input budget for that request, share
  of budget and of the hard limit
- `share`: request / budget over accepted requests: mean, min, mean and min after the first cut, p50, p95
- `ratioTrace`: every 25 calls, per model: the engine's calibration ratio, the true ratio (real tokens /
  engine estimate), the reported ratio (usage / estimate; lower than true when truncated), estimate,
  tokens, budget
- `cuts`: engine cut count and the call indices whose request was prepared with a new cut
- `prefix`: breaks (a request whose message list does not extend the previous one), where, breaks without
  a cut, cuts without a break; a trailing message carrying the engine's notice marker is request-only and
  is dropped from the previous request before comparing
- `silent`: truncated requests and indices, tokens dropped, calls where the engine reported a detection
  (`stats.plateaus` grew; the call index is the first request planned after it), `lagToDetection`
  (truncated requests before the engine's first detection)
- `falseDetections`: detections the engine reported with no truncated request since the previous one
- `engineStats`, `session` (turns answered/abandoned, class counts), engine SHA-256, corpus fingerprint
- `series`, one entry per provider call: `tokens` (real count as sent), `reported` (the `usage.input` the
  provider answered with: equal to `tokens` unless truncated, `null` if rejected), `budget`, `estimate`
  and `ratio` (the engine's), `flags` (R rejected, T truncated, C cut, B prefix break, N notice tail)
- `<run>.engine.log`: the engine's own log (cuts, overflows, plateaus) for tracing a mechanism

"Budget" is what the engine planned that request with (`stats.sent[i].budget`: window minus output
reserve; it shrinks when the engine learns a smaller window). Request size is the real count of the
request as sent, before any silent truncation.

## Pass criteria (checked per run, printed as PASS/FAIL)

A run PASSes when no criterion fails. A criterion is "n/a" where it cannot apply (C5, C6 in reject mode;
C7 for an engine that reports no detections) and "vacuous" when it passed only because nothing was
silently truncated (C5, C6). Calls are 0-based provider calls, rejected ones included.

| id | criterion | why this threshold |
|---|---|---|
| C1 | rejections at call >= 5 <= allowance. Allowance 0, except for an engine that re-probes learned limits (it reports `stats.probes`): (1 + probeConfirmations) per limit it learned from an overflow (`stats.learnedWindows`, new records) | Reject mode uses the declared window, so an engine that counts right is never rejected. Calls 0-4 are calibration warm-up. An engine that learns a limit and later re-probes it (to notice a temporary limit going away) is rejected once to learn it and once per failed probe until the limit is confirmed; that is designed behaviour, so it is allowed exactly that many times and no more. |
| C2 | largest request <= 1.02 x the input budget | The budget is window minus the output reserve; going over it eats the room for the answer. 2% covers estimator noise on a single request; anything more is a planning error. |
| C3 | mean request >= 0.45 x budget over accepted requests after the first cut (whole session if the engine never cut) | The engine cuts at 75% and cuts down to 45% of the budget, so after a cut no request should sit below the low-water mark for long; a mean below 0.45 means it over-estimates or cuts far below its band. A well-calibrated engine averages about 0.50-0.58 (r5: 0.502 to 0.579 over the 72 runs). The floor was 0.50 until round 5, which r5 cleared by 0.002 on the default seed; it was lowered so a harmless change does not fail the gate, and the value is reported as a trend instead (see "C3 trend" below). Ramp-up from an empty context is excluded because its length depends on session length and budget, not on the engine's accuracy. |
| C4 | prefix breaks == cuts, every break at a cut (a trailing request-only notice is ignored) | Between cuts the request must only grow, so provider prompt caches keep hitting; a break anywhere else is a cache miss the engine caused. |
| C5 | silent modes: at most 5 truncated requests in the session | Each truncated request is an answer produced without part of its context. 5 bounds the damage over a 500-turn session for any engine, including one that detects late but stops truncating after. |
| C6 | silent modes: at most 3 truncated requests before the engine's first reported detection (all of them if it never reports one) | Detection needs evidence; a detector should need at most a few samples (the r4 engine needed 3 consecutive ones by design). More than 3 means it waits through several band cycles while answers are produced from truncated input. |
| C7 | no detection reported without a truncated request since the previous one; in reject mode, no detection at all | A false detection shrinks the window for the rest of the session (it is never re-probed), so it costs window on an honest provider. |
| C8 | silent modes: every truncated request the engine could see is named as an answer produced from truncated input (`stats.plateauReports`). It could see a truncation that removed more than `plateauFlatness` (0.02) plus the engine's estimate error at that call (abs(estimate x ratio - real) / real), the error capped at 5% of the request so a worse estimator does not widen its own exemption; the band is fixed in ADR 0032. Truncations inside the band and answers named without truncation are listed in the summary's C8 section, with the false-name rate, and do not fail a run. Across the silent runs of a results directory, answers named without truncation may be at most 5% of the named answers (checked once 20 are named), and band-exempt truncations (inside the band and unnamed; count and tokens lost, reported beside C3) at most 10% of truncated requests (checked once 20 are truncated); the summary fails above either. | An unnamed answer from truncated input is a wrong answer nobody is warned about (invariant 3). Exact equality is out of reach: the engine sees only its estimate, which is a few percent off, so a truncation smaller than that error looks like an honest request. |

Notes:

- C5 and C6 count truncation the provider actually did, so they are engine-agnostic: an engine without a
  detector keeps truncating at every band top and fails both.
- C1 cannot fail in silent modes (those providers never reject) and is reported for completeness. Its
  allowance only matters with a provider limit below the declared window; the matrix's reject mode does not
  have one, but the self-test does (and records the C1 verdict for each error style).
- For an engine that plans against a very large budget (the round-1 baseline plans the 1M model at 983k),
  a 500-turn session may cut only a few times; C3 is then judged on the few hundred requests after the first
  cut, which is still a steady state.

## Known failures

`known-failures.json` lists runs that fail one named criterion within a recorded bound, accepted by decision
until a PENpi version. Each entry names the run id (exactly; no patterns), the criterion (only
`C6 detection-lag` is supported), `maxLag`, `until` (a version) and the reason. An entry covers a run only
when all of these hold: the id matches, that criterion is the run's only failing one, the engine detected at all
and the lag is at most `maxLag`, and PENpi's version (the root `package.json`) is below `until`.

- The run's own `<run>.json` still says FAIL; the criteria and their thresholds do not change.
- `suite.ts` lets that run's test pass and logs `[E2] KNOWN <id> ...`; `summarize.mjs` counts it as KNOWN
  (`- runs: 96, PASS 95, FAIL 0, KNOWN 1 (...)`), shows KNOWN in the table, and lists every entry under
  "Known failures": occurred, did not occur (the run passed: remove the entry), EXPIRED, or does not cover the
  failure.
- The summary fails when an entry has expired, is malformed, or names a run that is not in the default matrix
  (`run-e2.sh` with no selection). In any other set, such as a selection or the misconfigured runs, an entry whose
  run is not there is reported as not run. Anything an entry does not cover fails as before.

Today's entry: research.glm.32k.silent-messages, C6 lag 4 (limit 3), until 0.5.1. It is the same at this
checkout's path length and at the GitHub runner's.

## C3 trend

`summary.md` ends with the C3 distribution over the runs (min, p10, median, mean, and how many runs fall
below 0.50), and `summary.json` carries it as `c3`. With `E2_TREND_FILE=<path>` the summary also appends one
JSON line per results directory (time, engine label and SHA-256, seed, runs, failures, `c3`), so successive
runs build a trend. The weekly workflow does not keep the file between runs; each run's `summary.json`
is in its uploaded results. A median that falls while every run still passes is an estimator or planner regression.
The distribution pools every run in the directory, misconfigured runs included; give misconfigured runs a
results directory of their own (as the release runs do) so the trend compares like with like.

## Reading the output

`run-e2.sh` prints one line per run (`[E2] PASS coding.o200k.32k.silent-front ... rej=0/0<=0 max=0.798
mean-after-cut=0.53 cuts=20 breaks=20 trunc=1 lag=1 C1=ok ... C6=ok C7=ok`), then the summary, and writes
to the results directory:

- `summary.md`: engine label and SHA-256, tokenizer versions, corpus fingerprint, the PASS/FAIL table, worst
  cases. Each criterion cell starts with ok / vacuous / n/a / **FAIL**. Columns: C1 late rejections /
  allowed (total; first call indices); C2 max/budget (max/hard limit); C3 mean after the first cut (whole
  session; min after the first cut); C4 breaks/cut requests; C5 truncated requests; C6 lag (call of the
  engine's first detection, or "never"); C7 false detections; ratio err (engine ratio / true ratio - 1,
  min..max over the 25-call trace); hard limit; budget (first -> smallest, it shrinks after a detection);
  calls; seconds.
- `summary.json`, one `<run>.json` and `<run>.engine.log` per run, `selftest.json` (tokenizer sources,
  segment additivity, image rule values, what the engine's `parseOverflow` reads from each error style,
  short end-to-end sessions per error style and per silent style; `selftest.*.json` are those sessions),
  `engine.json` and `engine.context-engine.ts` (the exact engine bytes), `vitest.log`.
- `node summarize.mjs <dirA> <dirB>` prints a side-by-side comparison (`E2_COMPARE_OUT=<file>` saves it),
  one row per run, with the engine SHA-256 of each directory in the first row.

## Determinism

The plan, the content and the provider are deterministic given the seed and the checkout (the corpus
fingerprint in every result identifies the files used; the same tag gives the same fingerprint). Pi's
session entry ids are random and appear in the engine's window header and notices, so request sizes can
differ by a few tokens between repetitions. Re-running four 32k configurations with the round-4 engine
(CJK and data, GLM, reject and silent) reproduced every verdict, cut count, truncation count and rejection
count; per-request sizes differed by at most 63 tokens.

The checkout's path is part of every request: the sessions' working directory is under the checkout
(`.cache/scratch`), and Pi puts it in the system prompt. A checkout at another path length gives other request
sizes. RC5's matrix from a 91-character scratch path and from the GitHub runner's 99 characters gave the same
verdict, failing criteria and silent-truncation record in all 96 runs; the largest request per run differed by
-287 to +69 tokens.

The default matrix uses seed 1. Other seeds give other sessions (other tasks, sizes and content), which
is a cheap robustness check of borderline behaviour, for example the silent modes on the fast mixes
(about 2 minutes per seed on 2 cores):

    for s in 2 3 4 5 6; do
      E2_SEED=$s E2_MIXES=coding,research,cjk E2_TOKENIZERS=glm E2_MODES=silent-front,silent-messages \
        E2_OUT=.cache/results/seed-sweep/seed$s test/suite/context-engine-e2/run-e2.sh
    done

With the round-5 engine (bb13b622e5b0) such a sweep over seeds 2-6 (90 runs) found three FAILs that seed 1
does not show: C6 lag 5 twice in silent-messages runs, and C3 at 0.497 once (a pass under the 0.45 floor,
so 88 of 90 pass today).

## Files

| file | role |
|---|---|
| `run-e2.sh` | one-command entry point (CI) |
| `setup-tokenizers.sh`, `tok/` | tokenizer installation (pinned lockfile, SHA-256-checked downloads) |
| `tokenizers.ts` | o200k and GLM-5.3-Flash loaders, memoizing counter |
| `render.ts` | message normalization, chat templates, image rules |
| `provider-sim.ts` | provider simulator: real counts, three error styles, two silent truncation styles |
| `corpus.ts`, `content.ts` | repo corpus and the content generator |
| `mixes.ts` | the four session mixes and their plans |
| `engine-under-test.ts` | engine loading by path |
| `snapshot-engine.ts` | engine snapshot (the entry file and its relative imports) and its id |
| `runner.ts`, `metrics.ts`, `matrix.ts`, `suite.ts` | one run, its metrics and criteria, the matrix |
| `e2-*.e2.ts` | the matrix, one file per mix (vitest spreads them over workers); `.e2.ts` keeps them out of `npm test` |
| `sim.e2.ts` | self-test of the simulator, generator and error styles |
| `summarize.mjs` | summary tables and comparison; exit code |
| `known-failures.json`, `known-failures.ts` | accepted known failures and the rule that applies them (see Known failures) |
| `known-failures.test.ts` | unit test of the rule and the summary's counting (runs in `npm test`) |
| `vitest.config.ts`, `tsconfig.json` | config (temp files and Vite cache under `.cache/scratch`) |
