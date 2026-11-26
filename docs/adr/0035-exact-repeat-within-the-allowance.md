# 35. A repeat of the largest usage counts when the request was expected near it

- Status: Accepted
- Date: 2026-11-25

## Context

The context engine detects silent truncation from the input usage a provider reports (ADR 0032, behaviour E3.5).
One of its rules is the exact repeat. A server that fills its context, such as Ollama or llama.cpp at a `num_ctx`
below the model's window, reports exactly its limit for every request at or above it. So a sample that reports exactly
the largest usage reported so far again is evidence, when:
- calibration has settled (`silentSettledSamples`);
- the request is a different one from the request that set the maximum (expected sizes 0.5% or more apart);
- the request comes after no length stop or unjudged provider switch;
- the request was expected above the maximum, and at most 1.6 times it.

The last condition misses a request the engine estimates slightly low. E2's `data.o200k.32k.silent-front` on the
upstream v1.5.1 corpus (`dd30101cf`) fails C6 at lag 4 (limit 3), as a known failure until 0.9.0:
- The server holds 16,384 tokens and reports exactly that at calls 6, 9, 12 and 19.
- Call 6 sets the maximum; its growth reads clean.
- Call 9 reports 16,384 again, expected about 17,987: the first evidence.
- **Call 12** reports 16,384 again. It was sent with 16,425 tokens and lost 41 of them, but the engine expected about
  15,781, 0.963 of the maximum. The rule didn't judge it, and with 41 tokens lost its growth read clean.
- Call 19 is strong evidence, and the engine detects at 20.

On the v1.5.0 corpus (`f9a263655`) the same run passes at lag 3, and on v1.4.0 (`4a080252f`) at lag 2.

E2's other lag-4 case, `data.o200k.1m.silent-messages`, has a different cause:
- **v1.5.1:** truncations at calls 30, 31, 47 and 48, detection at 49.
- **v1.4.0:** truncations at calls 30, 31, 45 and 46, detection at 47.

The late truncated request (47, or 45) loses only the oldest message after the system prompt, the engine's own
window header: 398 or 415 tokens of about 1,000 appended. Its growth reads as honest.

## Decision

**The exact repeat counts within an allowance.** A sample that reports exactly the largest usage reported so far
again is evidence when its request was expected at or above (1 − `silentEstimateError`) of it, and at most 1.6 times
it. `silentEstimateError` is 0.05, an internal option for tests, not a setting. The other guards are unchanged. The
log line shows what the rule compared: the expected size, and the range it accepts.

**Why it is general, not fitted to call 12:**
- **The trigger is unchanged:** exact integer equality with the largest count ever reported. An honest count lands on
  one given number only by chance. A server that fills its context hits it on every request at or above its limit.
- **The allowance comes from the estimate, not from E2.** A request expected that close to the limit may still have
  reached it, since the engine's estimate of a single request is off by about that much.
- **The 5% is a working allowance, not a measured bound.** ADR 0032's grader caps the error it excuses at the same
  5%, and the error can run higher: six truncated o200k requests at 32k reached 5.2% to 8.1% (ADR 0032).
- **Below the allowance the old reasoning holds:** a request expected well under the maximum can't have reached the
  limit, so its repeat is a coincidence.

On E2's 288 runs the rule took a repeat below the maximum twice: call 12, and once on an honest provider (Results).
Chance does land on the maximum now and then. One repeat is weak evidence: it acts with a second suspect, or with a
growth marginal within the evidence span (ADR 0033).

**The same request sent again is no evidence.** An identical resend reports the same count, so the rule asks for a
different request than the one that set the maximum: a different shape, or the requests' own estimates 0.5% or more
apart. The shape is the messages that send anything: a session message by its identity, and the engine's own messages
(the window header, the notice) and system messages (the engine's checkpoint among them) by their text. The engine
rebuilds those with a new timestamp when it rebuilds its window, and the timestamp is never sent, so an identical
request must not look different for it. The shape is needed too: a different request, such as
the first after a cut, can land within 0.5% of the maximum's estimate, and if truncated it reports exactly the maximum.
Their expected sizes are not enough. The ratio moves after every clean sample, so a resend's expected size moves too, and with the
allowance below the maximum, a resend of a request first estimated 2.5% to about 6% low would pass. An overestimated one
already could. The log line "exact repeat not judged" shows each repeat the guard stops.

### Not adopted: a shortfall of about the oldest message

A second rule was built and tested for `data.o200k.1m.silent-messages`:
- **The rule:** growth short by about the request's oldest message after the system prompt. That message's text less
  its floor slack, in the floor's units, matched the shortfall within 5% of the two together.
- **Its guards:**
  - settled calibration;
  - no provider-switch reference;
  - the size guard;
  - evidence only next to a growth marginal already pending in the evidence span, and a marginal sample otherwise;
  - in a narrowed form, only when the two samples' [reported, expected) intervals overlap, each widened by the
    allowance, as one limit requires.

It brought both lag-4 runs to lag 3 on E2. It was dropped because it fails on honest content.

**The honest test** (`v090-honest-detection.test.ts`, below) ran 300 sessions: three mixes (ADR 0033's honest shapes,
E2 corpus text, both), 32k and 48k windows, and 50 seeds. Each kind of content has a provider scale of 0.7 to 1.8,
drawn per seed. Its bars were fixed before it ran:

| variant | sessions that detect | new against the shipped engine |
|---|---|---|
| the shipped engine with the rule off | 0 | – |
| the rule as evidence by itself (power only) | 78 | 78 |
| the rule with its pending-marginal guard | 32 | 32 |
| the narrowed rule | 26 | 26 |

- **Power was met:** a growth marginal followed by a match within 30 samples occurred 108 times, in 40 sessions,
  against a floor of 20 in 10.
- **Every false detection took one route:** a growth marginal pending, then a match.
- **The cause:** every match came after the session's first cut, and the message compared was the engine's own header,
  about 300 tokens. An honest append of 1,500 tokens whose content counts below the session's learned ratio falls short
  by that much.
- **The spread is realistic.** Claude's counts of the floor sweep against o200k run p25 0.86 to p75 1.50 per case, and
  the category medians p10 0.78 to p90 1.79. Even ordinary kinds sit 16% apart (code against text).
- **The narrowing didn't help:** honest pairs are close in size, so it removed only 6 of the 32.

So on this content, a shortfall of one header sits inside the honest estimate error, and the guard doesn't separate
the two. The trial code is on a local branch, not published.

### Kept: the honest test as a guard for any detection rule

`v090-honest-detection.test.ts` runs the detector against an honest provider that counts with o200k at a scale per kind
of content. Its variants are engine options, with the shipped defaults as the baseline. After each of a session's four
prompts it sends requests again, twice:
- **by the route a real session takes:** an answer that sends nothing, then an entry that isn't sent triggers a turn, so
  that request is the last one again;
- **from the same point:** one request of that prompt is sent again, the one that set the largest usage reported so
  far, with a chance of 0.8, when one in that prompt did. When the engine has cut since, what it sends differs.

The records keep only the resends that reported the same count again. Those are the shape the exact repeat's
different-request guard stops.

**Its bars, for any future rule:**
- **Safety:** the baseline detects in no session. Each session that detects with a candidate also detects with the
  baseline, and not at a later call.
- **Power:** the rule without its guard detects on some sessions, and the baseline's sessions hold the shape the
  guard has to stop at least 20 times in at least 10 sessions. For the exact repeat, that shape is a sample that
  reports exactly the maximum again for the same request, expected within the allowance below it, counted from the
  logged rows. The test counts it itself and prints "Power: N in M sessions".
  A full run writes its part of the count, and `HONEST_POWER_SUM=1` adds the parts, checks they cover seeds 0 to 49
  once, with three mixes and two windows each, by name, and that all of them ran one engine (its files' hash), and
  asserts the bar.

**How it runs:**
- **By default (CI),** a slice that needs no corpus: the shapes mix, a 32k window, 10 seeds with their resends, the
  shipped engine, asserting no detection and at least one guarded repeat, so a broken guard can't pass it.
- **With `HONEST_DETECTION=1`,** the full 300 sessions on a named corpus. It refuses the held-out revision. It is meant
  for before a new detection rule and before each release gate. It also runs each session with a provider that rounds
  its usage to 100 tokens. No supported provider is known to round, and the engine has no guard for one, so those
  sessions are recorded and not failed. Rounding turns an honest growth under 100 tokens into none, which the rule for an append
  with no growth reads as strong evidence (Results).
- **Each session runs in a fixed folder,** named by its mix, window, seed and reporter, and its system prompt names a
  fixed package folder instead of the checkout's. Both are in every request, so running a session again gives the
  same calls, from any checkout path.

## The exact path, later

With exact token counts, the exact repeat needs only an allowance for the template error, a few tokens. The truncated
request's exact count is over the limit, so the rule as it was before catches it.

`data.o200k.1m.silent-messages` is different. With exact counts, call 47 still grows 649 for 1,051 appended (0.62),
which the share bands read as clean. The fix there is a growth rule with a token tolerance on the exact path: growth
short of the append by more than a few tokens is evidence. It covers call 47 (398 short) and call 45 (415) without a
candidate size, which the honest test showed is the weak point. It needs:
- **The exact count in `expected`,** and it must match what the provider reports, including cached-input fields where a
  provider splits them.
- **An exactness gate,** established on samples before truncation can start. A server that begins truncating also
  makes deltas disagree with the append, so the gate must not drop on a mismatch. A mismatch after the gate is
  evidence. The gate drops only on a cause the engine can see: a provider switch, or a model or tokenizer change.
- **A measured tolerance:** per-message template and framing tokens on each provider family the exact path supports.
- **Its own honest test,** with counters that drift, under the same bars.
- **An E2 exact mode** against the same silent servers, to show lag 2 or less there.

None of it is built.

## Results

On the engine as it ships, 96 runs on each corpus, one worker. The table was run at E2's engine hash `f16b2fdf82b3`.
The shipped engine, `03365653ef6f`, differs from it only in the different-request guard (the requests' shapes and
estimates), which is read only where a sample reports exactly the largest usage. Every run with such a sample was rerun
on it, the 24 `silent-front` runs on each corpus and `research.glm.32k.reject` on v1.5.0, and each matches call for
call:

| corpus | known cases | false detections | wrong names | lags over 48 silent runs (lag: runs) |
|---|---|---|---|---|
| v1.5.1 (`dd30101cf`) | `32k.silent-front` lag 3 (was 4); `1m.silent-messages` lag 4, KNOWN | 0 (was 0) | 2 (was 2) | 1: 16, 2: 25, 3: 6, 4: 1 (was 3: 5, 4: 2) |
| v1.5.0 (`f9a263655`) | both lag 3, as before | 0 (was 0) | 3 (was 3) | 1: 21, 2: 20, 3: 7 (was 2: 19, 3: 8) |
| v1.4.0 (`4a080252f`) | `1m.silent-messages` lag 4, FAIL, as before | 0 (was 0) | 2 (was 3) | 1: 17, 2: 25, 3: 5, 4: 1, as before |

- The rule took a repeat below the maximum twice in 288 runs:
  - `data.o200k.32k.silent-front` on v1.5.1, call 12, expected at 0.963 of it: the fix;
  - `research.glm.32k.reject` on v1.5.0, an honest provider: a request expected at 0.998 of the maximum reported exactly it. That stayed one suspect and never acted.
- The other changes come from the checkout, not the engine. Pi's system prompt names the package's paths, and this run's checkout path counts 3 tokens fewer than the earlier runs'. The engine of 0.8.0, run from this checkout, gives the same shifted counts. In the two runs below the rule logged nothing, and on the runs that show the shift, the engine with this rule and without it gives the same calls. The shift moved:
  - `research.o200k.32k.silent-messages` on v1.5.0 to lag 2 (was 3);
  - on v1.4.0, the wrong name in `data.glm.32k.silent-front`, which is gone.
- The honest test's full run, on the shipped engine, with both resend routes: 300 sessions, 0 detections.
  - **Resends:** 2,221 reported the same count again (1,191 by a real session's route, 1,030 from the same point), 514
    of them at the maximum. 179 more reported a different count and are left out.
  - **Power:** the guard stopped a resend that reported the maximum again, expected below it, 25 times in 21 sessions.
    The test's summing step adds the runs' parts and asserts the bar.
  - **No honest repeat** is taken as evidence. Keyed by message identity, one was taken, in `mixed.48000.48`: the engine
    rebuilt its window header with another timestamp, and the same request looked like a different one.
  - **With the guard on expected sizes alone,** in the earlier run of the same seeds, 14 sessions detect, and 21 take a
    resend as evidence.
  - **With usage rounded to 100:** 55 sessions detect. 28 act on an append the rounding shows as no growth, and 27 on
    a rounded repeat of the maximum.

## Consequences

- E2's known failure `data.o200k.32k.silent-front` (v1.5.1, lag 4, until 0.9.0) is gone, and its entry is removed.
- **`data.o200k.1m.silent-messages` stays at lag 4 on the fallback path, as a known limit.** It holds on the v1.5.1 and
  v1.4.0 corpora; on the v1.5.0 corpus the run passes at lag 3.
  - **The cause is not the estimate.** The server drops the request's oldest messages, at calls 30 and 47 on v1.5.1 and
    at 30 and 45 on v1.4.0. A drop shows only on the request where it happens: the next request grows by exactly its
    append again (call 31), since the history stays the shorter one. On those requests the growth is 0.46 to 0.62 of
    the true append, where evidence needs below 0.25. Call 30 reads marginal and pairs with nothing, call 47 (45) reads
    clean, and the strong sample at 48 (46) detects at the next request.
  - **No estimate change reaches it.** The estimate of each append was within 4% of the true o200k count. A share of
    0.62 can't become evidence by a change to the estimate: the floor is never above `textTokens`, and an honest
    provider's growth is never below the true count. A prototype of 0.10.0's estimate changes (letters of other
    scripts, runs of one character) gave the same truncations and the same detection call.
  - **The estimate-based rules that would read it fail on honest content,** on E2's full runs (96 a corpus). A check of
    a request's reported total against its calibrated estimate: honest requests are over 5% short in 1.4 to 2.5% of
    calls, in 58 to 62 of 96 runs a corpus. A growth rule that reads a share of 0.62 as evidence (below 0.65): it takes
    honest samples as evidence in 11 to 32 of 96 runs a corpus, before the honest test's wider spread per kind of
    content. A narrower form already failed the honest test ("Not adopted").
  - **The exact path reaches lag 3, with no margin,** computed from the same runs' true counts. The exactness gate sets
    early (calls 1 to 29 are append-only and exact), and growth is judged on raw deltas: call 30's shortfall (6,466 of
    12,376 on v1.5.1; 6,780 of 12,523 on v1.4.0) is weak evidence, and call 47's 398 tokens (485 at call 45 on v1.4.0)
    complete the pair, so detection comes at 48 (46). The absolute bound takes none of the eight truncated calls: the
    dropped messages carry assistant text and templates, which it leaves out, and reported stays 300 to 9,800 tokens
    above the text count. The pair rests on call 30's evidence staying pending for 15 to 17 samples; nothing clears it,
    since the reports between climb by less than 2% above the running maximum each time. E2's exact mode is to confirm
    it on every release.
- Every new detection rule must pass the honest test's full run, under its bars, before it ships.
- **A known limit: a provider that rounds its usage.** With usage rounded to 100 tokens, 55 of the honest test's 300
  sessions detect. An honest growth under 100 tokens rounds to none, and the rule for an append with no growth judges
  the append by its estimate, so a repetitive append priced high reads as strong evidence. No supported provider is
  known to round. Judging that rule by the floor instead would weaken it where it matters most, on a server that
  reports exactly its limit. On the exact path, an append with no growth can be judged on its exact size, which ends
  the first half. A rounded repeat of the maximum stays a limit for a rounding provider.
