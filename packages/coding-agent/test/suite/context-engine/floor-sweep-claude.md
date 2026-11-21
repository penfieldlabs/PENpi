# Counting the floor sweep with Claude's own tokenizer

`floor-sweep-claude.mjs` counts every case of the floor sweep with Anthropic's token counter, on the Claude models Pi
lists, and checks each count against the context engine's growth-check floor. It reproduces the Claude figures that
[ADR 0033](../../../../../docs/adr/0033-marginal-pair.md) cites. You need your own Anthropic API key. Counting is
free.

## What it measures, and why

PENpi's context engine checks that a provider's reported usage grows by about what each request appended. If it
grows by far less, the provider may be cutting the input without saying so (silent truncation). The check judges the
growth against a floor, a lower bound on the appended text's real tokens (`textTokensFloor` in
`.pi/extensions/penpi/engine/estimator.ts`).

- If honest text's real tokens fall below **0.25** of its floor, an honest append reads as evidence of truncation.
  No case may.
- Between 0.25 and 0.5 a sample reads marginal: it never detects alone or with another marginal sample.

`floor-sweep.test.ts` checks the floor against two tokenizers that run locally, o200k and GLM-5.3-Flash. Claude's
tokenizer is not public, but the token counter (`POST /v1/messages/count_tokens`) gives Claude's own count of any
text. This script sends each of the sweep's cases there, one case as one user message, and reports real tokens over
the floor for each model.

## What you need

- **Node** at the version the repository's `engines` field sets (22.19 or later). The script imports the
  repository's TypeScript sources directly.
- **The repository's dependencies:** run `npm ci` at the repository root.
- **An Anthropic API key**, in the environment variable `ANTHROPIC_API_KEY`. The script reads it from there only,
  and never prints, logs or writes it. It prints only whether the key is set, and any error message that holds the key
  shows `<key>` in its place.

## What it costs

`count_tokens` is free: counting bills nothing. It is rate-limited, though: Anthropic limits token-counting
requests a minute by usage tier, separately from message requests. See your organization's limits in the Anthropic
Console.

Two settings control how fast the script goes:
- `RATE` caps requests a minute (default 1,000). Set it at or below your tier's limit for token counting.
- `CONC` caps requests in flight (default 16). At about 0.2 to 1 second a request, 16 in flight is enough for 1,000
  a minute. Lower it if you lower `RATE` a lot.

If you go over the limit anyway, the API answers 429 and the script waits as asked (see below).

The times below are at the default `RATE` of 1,000 a minute. They scale with it: at 100 a minute, everything takes
ten times as long.

## How to run it

Run every command from the repository root. On macOS or Linux:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
node packages/coding-agent/test/suite/context-engine/floor-sweep-claude.mjs key
```

On Windows PowerShell, set the key with `$env:ANTHROPIC_API_KEY = "sk-ant-..."`, then run the same `node` command.
To keep the key out of your shell history, read it from a file or a secrets manager into the variable instead of
typing it.

### The phases

| Phase | What it does | Network |
|---|---|---|
| `key` | says whether `ANTHROPIC_API_KEY` is set | none |
| `overhead` | each model's request overhead (see below) | 6 requests a model |
| `probe` | overhead, then every 64th case of the sweep (381 of the full sweep) on each model, then the groups | about 7 minutes for all models |
| `sweep` | the whole sweep on `MODELS` | about 25 minutes a model |
| `report` | the reports again from what is counted, with the floor in your checkout | none |
| `billing` | the optional paid check (see the last section) | free unless `PAID_CHECK=1` |

A typical run (in PowerShell, use `$F = "..."` and `$env:MODELS = "all"` in place of the sh forms):

```sh
F=packages/coding-agent/test/suite/context-engine/floor-sweep-claude.mjs
node $F probe                  # every model, about 7 minutes: which models count alike
node $F sweep                  # the full sweep on the first model of each group: four groups, about 100 minutes
MODELS=all node $F sweep       # every model: 18 models, about 7.5 hours
node $F report                 # print the reports again, no network
```

A quick try, on two models and the first 50 cases, takes under a minute:

```sh
MODELS=claude-haiku-4-5,claude-fable-5 LIMIT=50 node $F sweep
```

### The variables

| Variable | Default | What it sets |
|---|---|---|
| `ANTHROPIC_API_KEY` | none (required) | the API key |
| `MODELS` | every Claude model in `packages/ai/src/providers/data/anthropic.json`; for `sweep`, the first model of each probe group | comma-separated model ids, or `all` |
| `OUT` | `floor-sweep-claude` in the system's temp directory | where the results go |
| `BASE_URL` | `https://api.anthropic.com` | the API's address |
| `RATE` | 1000 | requests a minute at most |
| `CONC` | 16 | requests in flight at most |
| `FLOOR_SWEEP_FULL` | 1 | 0 for the default sweep (20,751 cases) instead of the full one (24,321), as in `floor-sweep.test.ts` |
| `LIMIT` | all | only the first `LIMIT` cases of the sweep |
| `PAID_CHECK` | off | 1 to let `billing` send its paid requests |

## How a case is counted

- **The overhead.** The counter counts a request's wrapper as well as the text. A single lowercase letter is one
  token for Claude, so a letter's count less 1 is the model's overhead. The script counts six letters, and they must
  agree. If they don't, the report says so. Other short texts are not safe for this: on some models a digit counts 2,
  and from Opus 4.7 on, `Q` and `Z` count 2.
- **Trailing line feeds.** The counter drops line feeds at the end of a text ("hello" and "hello" plus a line feed
  count the same), and refuses a text that is only whitespace. So a text whose trailing whitespace holds a line feed,
  or that is refused as whitespace only, is sent with an `a` after it, and counted 1 less. Its row is marked
  `suffixed`.
- **Lone surrogates.** Some cases cut an emoji in half. A lone surrogate is not valid in the request's JSON, so it is
  sent as U+FFFD, as a UTF-8 client sends it. Its row is marked `fffd`. The floor is that of the case as it is.
- **Real tokens** are the count less the overhead (and less 1 for a suffixed row).

## What it writes

Everything goes under `OUT`:

| File | What it holds |
|---|---|
| `run.log` | every line the script printed, with a time stamp |
| `overhead/<model>.json` | the letters' counts and the overhead |
| `probe/<model>.jsonl`, `sweep/<model>.jsonl` | one line per counted case: `k` (the case's name), `n` (the count), `mode` (`suffixed`, `fffd`), `chars`, or `err` |
| `probe/<model>.report.json`, `sweep/<model>.report.json` | one row per case, `{ name, chars, floor, real, ratio, mode }`, lowest ratio first |
| `probe/groups.json` | the groups (see below) |
| `summary.json` | written by `report`: each model's cases counted, refused, overhead, cases below 0.25 and 0.5, and the lowest |
| `billing.json` | written by `billing`: each text's count, billed tokens if sent, and the estimated cost |

**Reading a report.** After each model, the script prints one line such as:

    claude-haiku-4-5: 24321 of 24321 cases counted (0 refused); overhead 7; below 0.25: 0; below 0.5: 14; lowest 0.280 "..."

Then it lists every case below 0.25 with its floor and real tokens. `ratio` is real tokens over the floor:
- **below 0.25:** that honest text would read as evidence of truncation;
- **between 0.25 and 0.5:** it reads marginal;
- **0.5 or more:** it reads clean.

A case with a floor of 0 that Claude counts at 0 reads 1.

**The groups.** Many Claude models share a tokenizer. The probe counts the same 381 cases on every model, and models
whose counts are identical on all of them form a group. Counting one model per group then covers them all, which is
why `sweep` defaults to the first model of each group. To be sure, `MODELS=all` counts every model.

**Comparing with ADR 0033.** The ADR's figures are for the full sweep, with the floor at the version it describes:
- the four groups;
- no case below 0.25 in any group;
- 14 cases below 0.5 (the 4.5 and 4.6 models, and Opus 4.7) or 51 (the later models);
- the lowest at 0.280.

To compare:
1. Run `probe` and `sweep` with the default `FLOOR_SWEEP_FULL=1`.
2. Compare `summary.json`, or the printed lines, with those figures.

The floor is computed when the report is made, from the checkout you run in. So after a change to the floor, `report`
re-prices what is already counted, with no new requests. A model the API has added or retired since will show up as a
new group, or as not counted (the API answers 404 for a model it does not know).

## Resume, and errors

**Resume.** Every count is appended to its `.jsonl` file as it arrives, and a run skips the cases already counted.
If a run stops (Ctrl+C, a lost connection, a closed laptop), run the same command again and it carries on. A case
recorded as an error, with no count, is counted again on a rerun. Once it is counted, its old error rows are no
longer read, so the report shows only errors that are still there. An overhead file with a letter that was not
counted is counted again the same way. To start over, delete `OUT` or pick another one.

**Errors:**

| Error | What it means | What to do |
|---|---|---|
| "ANTHROPIC_API_KEY holds a character an HTTP header can't carry" | the variable holds a line break, a space or another character a key does not have, often from reading a file with two lines | The script stops before any request. Set the variable to the key alone. |
| 401 or 403 | the key is missing, wrong or not allowed | The script stops at once. Check `ANTHROPIC_API_KEY`, and that the key belongs to an organization that can use the API. |
| 429 | over the rate limit | The script waits as long as the response's `retry-after` asks (10 seconds if it gives none), then goes on. Many 429s mean `RATE` is above your tier's limit, so lower it. |
| 5xx, or a network error | the server or the network failed | The script retries up to 8 times, waiting longer each time (about 4 minutes in all), then records the case as an error. A rerun counts it again. |
| "request not sent" | the request could not be built (for example a header Node refuses) | The script stops at once, without retrying. |
| any other 4xx | the API refused the request (for example a model it does not know) | The case is recorded with the error and counted in "refused". The first five refusals are printed with their messages. |

## The optional paid check

Do real requests bill what the counter counts? The `billing` phase checks this with a few short texts per model:
- a letter;
- 500 BEL, 500 U+0090 and 500 CR between two letters;
- 20 progress lines redrawn with CR.

Each text is first counted for free. Without `PAID_CHECK=1`, that's all: the script prints the counts and what
sending would cost, at the prices in `anthropic.json`, and sends nothing. With it, each text is also sent to
`POST /v1/messages` with `max_tokens` 1, and the script compares the billed input tokens with the count:

```sh
node $F billing                 # free: counts, and the estimated cost
PAID_CHECK=1 node $F billing    # paid: 5 requests a model
```

`MODELS` defaults to the first model of each probe group, else `claude-haiku-4-5` and `claude-haiku-5-5`. At list
prices, the ten requests on those two models cost about $0.0002 together, and five requests on any one model cost well
under a cent.
Each request asks for at most one output token. The results go to `billing.json`.
