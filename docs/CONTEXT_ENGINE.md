# Context engine

PENpi 0.5.0 manages the context window with the context engine
(`.pi/extensions/penpi/engine/`). It replaces FIFO (ADR 0003) and the compaction fallbacks
around it (ADRs 0023, 0025, 0027 and 0028). Nothing is summarized and nothing is deleted. The
session file keeps the whole transcript verbatim, and the engine only decides what the model sees
on each request. [ADR 0032](adr/0032-context-engine.md) records the design and the decisions
made while porting it.

## What it does

- **A persistent window with hysteresis.** When the projected request crosses `highWater` (75%)
  of the input budget, the engine cuts at a turn boundary so the request falls to `lowWater`
  (45%). The cut is saved as a session entry, so the window stays the same across requests, which
  keeps the provider's prompt cache. Messages before the cut leave the model's view, not the
  session.
- **A header after each cut.** The header says what left the window and how to get it back. It
  carries the user's earlier messages verbatim (the pin: only messages a person typed, capped at
  min(10% of the window, 20,000 tokens)). It also carries the model's working notes
  (`context_notes`).
- **The pin marks what is done.** Each carried message is shown with the UTC day it was sent.
  Every message that is not the current request is labelled *earlier request, already handled*:
  its rules still apply, and its task is not done again unless the current request asks for it.
  The label is the same when a long message becomes a pointer or several become a range line. A
  line of its own names the current request (the prompt of the latest run): *marked current
  request in the pinned messages above* when it left the window, or *in your context below*, with
  its first 200 characters, when it is still there. That line ends: *when the current request is
  done, stop and report; do not start requests from earlier messages.* A run with no current
  request gets no such line. Like the rest of the header, this text is fixed at the cut (D26).
- **Recall and search.** `context_search` finds text that left the window, and `context_recall`
  reads it back. A tool result is searched together with its call's argument values (a read result
  by the path it read), and a hit on a tool call names the result entries of the calls that matched. When no entry has every word, it lists the
  entries with some of them, most words first. The pinned notes and the user messages make these lookups rarely needed. Durable
  facts still belong in Penfield (tier 2), and `search_transcript` still searches earlier
  sessions (tier 3).
- **Estimates calibrated to the provider.** The engine estimates every request from what Pi
  actually serializes for the model's API. It learns a per-model ratio between that estimate and
  the provider's reported input tokens.
- **Limits it learns.** Overflow errors teach the real window. Output-limit errors and repeated
  length stops teach the real output ceiling. A provider that silently drops input, without an
  error, is detected from usage that stops growing. Learned limits carry their evidence, are
  re-probed later, and are cleared with `/penpi reset-limits`. When the engine detects silent
  truncation, it names the answers that were produced from truncated input.
- **Recovery without compaction.** An overflow is retried with a smaller window, at most 3 times
  per run. A response cut off at the output limit gets up to 3 continuations per run. A response
  that spent the whole output limit on reasoning, with no text and no tool call, is asked for the
  answer directly (`reasoningOnlyContinuation`).
- **Broken tool calls are repaired in the request.** Some providers return a tool call with no id
  or no name. Pi records it, and a provider that checks ids rejects every later request. The engine
  leaves a call with no name out of what it sends, with the note *[a tool call with no name was
  removed from this request]*, and drops its result. A call with a name but no id keeps its result:
  both get the same id, made from the saved message, so every request carries the same bytes. The
  session file keeps what was recorded. The engine log notes each kind of repair once, and `/penpi
  doctor` counts the repaired requests.
- **Large units are capped.** One tool result or user message may use at most 25% of the input
  budget. The rest stays recallable. Images count toward the budget.
- **A ceiling.** The engine plans against min(model window, 200,000 tokens) (`windowCeiling`).

Compaction stays off. The engine cancels every compaction request. A manual `/compact` moves the
window forward instead, and `/tree` summaries get a fixed notice. The engine refuses to run
(error, shutdown, no model request) while `compaction.enabled` is set to `true`. PENpi's default,
with the setting unset, is off.

## Settings

Engine settings live in the `penpi` block of the global `~/.pi/agent/settings.json`, like
PENpi's other settings (ADR 0026). A value of the wrong type or out of range is ignored with a
warning, and the default applies (ADR 0030).

| setting | default | meaning |
|---|---|---|
| `windowCeiling` | `200000` | plan against min(model window, this); `0` or `null` disables it |
| `highWater` / `lowWater` | `0.75` / `0.45` | cut above this fraction of the input budget, down to that one |
| `maxUnitFraction` | `0.25` | the most of the input budget one tool result or user message may use |
| `outputReserveFraction` | `0.2` | the share of the window reserved for output, capped by the model's max output |
| `limitOverrides` | `{}` | per model (`"provider/modelId"`): `contextWindow`, `maxTokens`; an explicit window bypasses `windowCeiling` |
| `replayedReasoning` | `{}` (all `"counted"`) | per model: `"ignored"` when the provider does not count the reasoning Pi replays; set it only on evidence. The engine checks it online (reported growth against appended text plus replayed reasoning, over 20 or more request pairs with no cut) and warns once when the setting disagrees with the provider, or when it is `"ignored"` and some request pairs show the provider counting it |
| `reasoningOnlyContinuation` | `"answer"` | after a reasoning-only length stop: `"answer"` asks for the answer directly, `"continue"` sends the ordinary continuation |
| `maxLengthContinuations` | `3` | continuations per run after a length stop |
| `pinUserMessages` | on | `null` turns the pin off; an object (`capFraction`, `capMaxTokens`, `protectFirst`, `longMessageChars`, `sources`, `unrecordedSource`, `agentPrefixes`) changes it |
| `notice` | `false` | `true` adds a request-only notice shortly before a cut, naming what will leave view |
| `serializeAs` | — | per model or API name: which of Pi's converters its requests go through, for providers registered under their own API name |

`engine/options.ts` lists every option with its documentation. The detector's thresholds and the
retry bounds are settings too, but they are tuning values, not user settings.

PENpi 0.4's FIFO settings (`contextFloor`, `contextCeiling`, `emergencyCompactionRuns`) and their
environment variables (`PENPI_CONTEXT_FLOOR`, `PENPI_CONTEXT_CEILING`,
`PENPI_EMERGENCY_COMPACTION_RUNS`) are no longer read. PENpi warns at startup when one is set and
names it.

## Diagnostics

- **Status line.** For example, `ctx 200k (model 1.0M, ceiling) · req 61k/120k · 2 cuts · ratio 1.04`.
  It shows the window the engine plans against, the model's own window when they differ (and
  why), the last request against the cut threshold, the number of cuts and the calibration ratio.
- **`/penpi doctor`.** It prints the effective window and output limit, and where they come from.
  It also shows the band, the calibration ratio and its samples, and the learned limits with their
  evidence. It names the answers produced from truncated input, and the settings that apply. It
  says when silent-truncation detection is unavailable because the provider reports no usage.
- **`/penpi reset-limits`.** It forgets every window and output limit learned in this session, for
  every model, including those learned from silent truncation.
- **`PENPI_ENGINE_LOG=<path>`.** Off by default. When set, the engine appends its log to that file:
  cuts, pin decisions, learned limits, provider errors and recovery. Each line is timestamped. It
  also writes one telemetry report per request (`telemetry {json}`): request number, message
  count, cuts, notices, silent-truncation detections, the refusal flag, the pin's size, the limits
  when they change, and the active tools on the first request. The same report is emitted as the
  status `context-engine.telemetry`. The log holds no prompt or message text, only ids, sizes,
  ratios and decisions. The text of provider errors, which can echo the request, is replaced by its
  length. Without the variable, there is no file and no telemetry status.

## Routers such as OpenRouter

A router such as OpenRouter serves one model through several upstream providers, and it may move a
session from one provider to another between requests. Each switch loses the provider's prompt
cache. In the 0.5.0 trial on OpenRouter's GLM 5.3 Flash, the first request after a switch cost 15
times the one before it. Providers also count the same request differently. Until D24 (in 0.5.0) the engine
could read the difference as silent truncation and lower the session's window for the rest of the
session.

The engine now reads the name of the provider that served each response (OpenRouter's stream
reports it on every chunk) and keeps each provider's samples and evidence apart. A response from a
different provider than the previous one is judged against that provider's own last response, when
no cut came in between. When that provider has served nothing since the last cut, the response is not
judged, and a real truncation is detected from the next response on. The engine log shows each
switch:

```
serving provider changed (OpenInference -> Crusoe): judged against Crusoe's sample 12 request(s) back
serving provider changed (OpenInference -> Crusoe): no sample from Crusoe since the last cut; the usage sample is not judged for truncation
```

A route that moves to another provider right after most cuts leaves those first responses unjudged,
so a truncating provider is detected later. A provider preference avoids that.

To keep a session on one provider, and keep its cache, set a provider preference for the model in
Pi's `models.json`. Pi sends it as OpenRouter's `provider` routing field:

```json
"compat": { "openRouterRouting": { "order": ["<slug>"], "allow_fallbacks": true } }
```

- `order` with `allow_fallbacks: true` keeps working through an outage of the first provider, but a
  session can still move to the next one.
- `only: ["<slug>"]` with `allow_fallbacks: false` never moves the session, and requests fail while
  that provider is down.

To change the preference in a running session, edit `models.json`, type `/model` with no argument,
wait for "Model catalogs refreshed.", and select the model. An exact `/model <provider>/<model>` keeps
the model object Pi already has, with the old routing.

The slugs are on the model's page on OpenRouter, or in
`GET https://openrouter.ai/api/v1/models/<author>/<model>/endpoints`. The other routing fields
(`ignore`, `sort`, `quantizations`, `max_price` and so on) are sent the same way.

## The engine without PENpi's other features

`.pi/extensions/penpi/engine-only.ts` loads the engine alone, without Penfield memory, MCP,
orientation or web search:

```bash
pi -e .pi/extensions/penpi/engine-only.ts
```

The release-gate benchmark uses this entry, because Penfield memory would carry facts across
sessions and arms. It builds the engine with the same function, settings and defaults as the full
extension (a test checks that the resolved options are identical). It registers `/penpi doctor`
and `/penpi reset-limits` itself.

## Security: memory in the system prompt

PENpi puts its orientation briefing (its protocol, then Penfield's awaken and reflect) into the system
prompt's `<penpi-memory>` section, which gives the text system-level authority. Some of that memory was
written by other agents or copied from the web, so it is passed as data: between
`=== BEGIN/END PENFIELD PERSISTENT MEMORY ===` fences, after one line saying it is reference data and not
instructions, as one JSON object on one line with `<`, `>`, `&` and the JSON line separators escaped. No
memory text can close the section, open a tag or start a line of its own. The section is byte-stable
within a session and changes only at a cut, a mid-session `/penpi login` included (ADR 0032). It is
capped at 20% of the planning window and at most 24,000 tokens, since the engine cannot cut the system
prompt. When the window shrinks (a smaller model selected, a window learned from an error or from silent
truncation), the section is composed again for the new cap before the next request and takes effect at a cut
made there; on a model whose window does not change, it never changes for this reason. A resume on a smaller
model usually needs none of this, since the session-start orientation composes the section for that model; the
cut applies only when it was not recomposed, for example when Penfield is unreachable at the resume and an
earlier cut's section is still in effect. A window too small for the system prompt even with the memory cut is refused before any
request is sent. The session file records only a hash and length of the memory read, and `search_transcript`
does not return state entries, so memory text does not come back as tool output outside the fence.

## Testing with fault injection

`PENPI_FAULTS` makes the engine turn some successful responses into failures, to exercise its
recovery without a provider that misbehaves. It is a testing tool, set only in the environment:

```bash
PENPI_FAULTS='overflow=every:7;output-limit=p:0.1;length=at:3,9;seed=42' pi
```

Each rule is `every:N` (every Nth response), `at:A,B` (those responses) or `p:X` (with probability
X, from `seed`); the faults are `overflow` (a context-overflow error), `output-limit` (an output
limit error) and `length` (a length stop with the text halved). While it is on, PENpi says so at
startup, on every fault, in the status line and in `/penpi doctor`. `PENPI_PRODUCTION=1` marks a
deployment as production and refuses it. `penpi.faults` and `penpi.production` are not settings;
PENpi ignores them with a warning.

## Session entries

The engine writes custom entries of type `context-engine`, which never enter the model's context:

- `{ kind: "cut", firstKeptEntryId, seq, header, hv }`: a cut, with the header rendered for it and
  the header format it was made with (`hv`, 2 since D26; missing before). A session whose latest cut
  has an older or no format cuts once at its first request, so its header is made in the current
  format (the log line says `header format 1 -> 2`);
- `{ kind: "model", ... }`: the learned state per model (ratio, learned limits, evidence);
- `{ kind: "plateau", key, window, turns }`: a silent-truncation detection, with the answers it
  names;
- `{ kind: "source", at, source }`: where a user message came from (interactive, RPC or an
  extension), for the pin;
- `{ kind: "run", prompt }`: the prompt of each run; with the pin off, it supplies the pinned task
  and the latest instruction.

A session resumed with a different model plans with that model's own state.

## Tests

- **Behaviour suite.** `packages/coding-agent/test/suite/context-engine/` runs each behaviour
  against a real Pi session, with a faux provider and a provider simulator. It needs no keys.
- **E2.** `packages/coding-agent/test/suite/context-engine-e2/` simulates long sessions with real
  tokenizers (o200k_base and GLM, pinned): 4 mixes × 2 tokenizers × 3 windows × 4 provider
  behaviours. `setup-tokenizers.sh` installs the tokenizers, and `run-e2.sh` runs the matrix and
  prints a summary. Its README lists the criteria.
