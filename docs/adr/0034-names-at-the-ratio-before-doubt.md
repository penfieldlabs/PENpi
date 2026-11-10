# 34. Truncated answers are named at the ratio from before the first doubtful sample

- Status: Accepted
- Date: 2026-11-10

## Context

At a detection of silent truncation (ADR 0032, behaviour E3.6), the engine names every answer produced from truncated
input. D14 names a recent sample when its expected size, the engine's estimate times the calibration ratio at the
time it was sent, is above the learned window by more than `plateauFlatness` (0.02). The learned window is the
largest usage ever reported.

The ratio a sample was judged at can be too low. A marginal sample (growth below `silentMarginal`, ADR 0033) is not
quarantined, so its truncated report feeds the ratio like any clean sample. Every later sample is then expected a
little smaller than it is.

E2's `data.o200k.1m.silent-messages` on the upstream v1.5.1 corpus (`dd30101cf`) fails C8, an unnamed truncated
answer:

- **Call 30** is truncated and marginal (+5,910 for 12,639 appended, about 0.47). It moves the ratio from about
  0.99264 to 0.98108.
- **Call 31** is truncated too (103,406 tokens sent, 96,940 counted). The server dropped the same messages for 30
  and 31, so its usage grew by exactly what was appended (+947). No growth rule marks it.
- **Call 48** is strong evidence (−1,322 for 2,958 appended), and the engine detects at 49. The learned window is
  call 47's report, 99,718, so D14's line is 101,712.
- **At detection, call 31's expected size is 103,603 × 0.98108 ≈ 101,643: about 70 tokens under the line.** At the
  ratio from before call 30 it would be about 102,840, above it.

0.7.0 (`d735229e9`) fails the same way on this corpus, with call 31 unnamed. ADR 0033 doesn't bear on it: call 31
is clean, and a strong sample detects alone, so no marginal sample joins. On the v1.5.0 corpus, call 31 was marginal
itself and was named through ADR 0033's join.

Two facts limit a fix:

- **The marginal samples are gone by the time detection runs.** The marginal list is emptied when evidence comes, and
  a sample in the D14 list does not say it was marginal.
- **A ratio can also fall for real.** After a cut the content changes. In the same run on the v1.5.0 corpus, the
  ratio falls from about 1.01 to 0.969 after the cut at 32, and requests 45 to 47 near the window are honest. Judged
  at 1.011 across the whole span, 46 and 47 would be named.

### Not adopted: a marginal sample does not move the ratio

It needs no rescale. But it changes the requests wherever honest marginal samples occur (`git diff --stat` output
reads about 0.5). So cuts, the pin-off equivalence test and many E2 runs would move.

### Not adopted: rescale every sample in the span

A simpler form of this fix judges every sample in the span at the ratio from before the first doubtful one. A
real fall of the ratio after a cut would then name honest answers. In the same run on the v1.5.0 corpus:

- **The doubtful sample:** call 30 is marginal, judged at 1.011. The window is 99,723, so the line is 101,717.
- **The honest requests:** after the cut at 32, requests 45 to 47 are honest. They were sent at 99,073 true tokens or
  fewer, under the server's limit. They were judged at 0.97 and 0.969, which is right for that content: true tokens
  over the estimate is about 0.968.
- **At 1.011 across the span,** call 46 would be expected at 101,325 × 1.011 ≈ 102,440, and call 47 at 102,367 × 1.011
  ≈ 103,493. Both are above the line, so both would be named.

Within one append chain, by contrast, the request is the previous one plus what was appended. The content mix moves
only by the appended part, so a ratio that falls right after a doubtful sample is far more likely to come from that
sample than from the content. A cut starts a new chain, with content the ratio has not seen. So the rescale stops at
the chain's end, and a later chain is judged at its own ratio unless it has a doubtful sample of its own.

## Decision

At a detection, D14 also judges each sample of an append chain from that chain's first doubtful sample on (that one
included) at the ratio from before that sample, and raises only (`silentNameRescale`, on; an internal option for
tests, not a setting):

- **A doubtful sample** is one quarantined as evidence, or marginal by its growth. Each recent sample now records
  whether it was marginal when judged, and its append chain (D24: consecutive append-only requests; a cut, a rebuild
  or any other change starts a new one).
- **A cleared marginal sample is not doubtful.** When a clean sample clears the marginal samples (ADR 0033: above
  everything reported by more than `plateauFlatness`), the engine has judged them honest, and their flag is removed.
  Honest content that reads marginal is followed by a real, lower ratio for what comes after it in the chain, so
  raising those samples back would name honest answers. A cleared *suspect* keeps its mark and is named, as before
  this change; the rescale follows it there too.
- **The rescaled expected size** is max(expected, expected / ratio × r0), where r0 is the ratio the chain's first
  doubtful sample was judged at. A sample whose rescaled size is above the learned window by more than
  `plateauFlatness` is named.
- **Per chain only.** Within a chain the content only grows. After a cut it changes, and a ratio that fell there is
  not taken as doubtful.
- **Names only.** The ratio restored at detection, the learned window and the samples counted as affected are as
  before, computed from D14's set as before. The wider set only goes to the names: the log, the warning and the
  `{kind:"plateau"}` entry. No request changes.
- **How a rescaled name is shown.** A named answer's `expected` stays the size it was judged at, and during a
  re-probe it is labelled a re-probe answer only when that size is above the learned window, as before. So an
  answer named only through the rescale is listed as an ordinary truncated answer, with its own expected size. The
  label says which request carried the probe, and that is a question about the request as sent, not about the
  ratio the engine would judge it at now.

## Results

E2 on both corpora, with this rule against the same engine without it: on the v1.5.1 corpus only
`data.o200k.1m.silent-messages` changes. It names calls 30, 31 and 48, where it named 30 and 48; C8 passes, and C6
stays at lag 4. On the v1.5.0 corpus and in both misconfigured sets nothing changes apart from timestamps and run
times. No wrong name is added.

On the run's own figures:

- `data.o200k.1m.silent-messages`, v1.5.1 corpus: calls 30, 31 and 48 are named (30 and 48 before). C8 passes; call
  47 stays unnamed, within C8's band (398 tokens). C6 stays at lag 4.
- The same run on the v1.5.0 corpus: names unchanged (30, 31, 48). Calls 45 to 47 are in the chain after the cut,
  and that chain's first doubtful sample is call 48 itself.

## Consequences

- **False names are possible within a chain.** A chain whose first doubtful sample was honest and never cleared,
  followed by a real fall of the ratio within the same chain and honest samples near the window, can name an honest
  answer. The clearing closes the usual form of it: honest samples that climb past everything reported clear the
  marginal sample first. A false name
  adds one "may be unreliable" turn to the warning; it detects nothing and changes no request. E2 reports a wrong name
  in `named.wronglyNamed`.
- **A truncated answer in a later chain than every doubtful sample is still judged at its own ratio**, as before.
- **Tests:** `engine/name-rescale.test.ts`, on the run's own figures:
  - `data.o200k.1m.silent-messages` on v1.5.1 names call 31;
  - with the rule off, the names are today's;
  - an honest fall of the ratio after a cut names nothing new, and the same rule across the whole span would;
  - raising only: a sample at a ratio above r0 keeps its own expected size;
  - a chain with no doubtful sample keeps today's names;
  - samples before a chain's first doubtful sample keep their own ratio.

  And `test/suite/context-engine/v080-name-rescale.test.ts`, through the detector in a scripted session:
  - that run's shape (a marginal truncated request, the next one grown by exactly its append, then a strong sample):
    the second is named with the rule on and not with it off, and the requests are the same;
  - an honest marginal sample, cleared, then a real fall of the ratio in the same chain: no extra names. Without the
    clearing, an honest answer near the window is named.

  The pin-off equivalence test and the engine suite must pass unchanged.
