# 29. Normalize and bound memory text before fence sanitization

- Status: Accepted
- Date: 2026-10-11

## Context

[ADR 0024](0024-memory-fence-sanitization.md) neutralizes forged trust-wrapper fences in
Penfield briefing and reflection text by rewriting runs of `=` next to the wrapper's own
marker words. Three gaps remained:

- **Disguised fences.** The passes matched only ASCII `=` and the labels' exact case. A
  model reads `＝＝＝ ＥＮＤ PENFIELD …` (fullwidth), `=== end penfield persistent memory ===`
  (lowercase), or a fence split by zero-width or bidi characters (`=​==`,
  `E‍ND`) as the same fence, but none of them matched.
- **Quadratic matching.** The mid-line pass, `(={3,})` followed by a label, was not
  anchored to the start of a run, so a long run of `=` was retried from every position
  inside it. A label, a few spaces and 16,000 `=` took about a second; four times that
  about sixteen. The text comes from a remote service.
- **Unbounded size.** Nothing limited how much remote text was matched or injected.

## Decision

`sanitizeMemoryText()` now, before its passes:

1. applies **NFKC normalization**, folding compatibility forms to the characters a model
   reads them as;
2. **strips Unicode format characters** (`\p{Cf}`: zero-width spaces and joiners, bidi
   controls, BOM);
3. **caps the text at 64,000 characters** (`MAX_MEMORY_TEXT_CHARS`, about 16k tokens),
   without splitting a surrogate pair, and appends a note giving the number of characters
   omitted.

The label passes are **case-insensitive**, and the mid-line pass matches a run only from
its first `=` (`(?<!=)`), which makes it linear.

## Consequences

- The disguised forms above are neutralized; tests cover each, and the timing test fails
  against the unanchored pattern.
- Normalization rewrites the injected text, not only the fences: a ligature becomes two
  letters, fullwidth punctuation becomes ASCII, and a zero-width joiner inside an emoji
  sequence is dropped, splitting the sequence into its parts. ADR 0024's
  "character-for-character" property now holds only for text without such characters. The
  session state entry still keeps the raw text, with the injected variant alongside
  whenever sanitization changed anything.
- A briefing or reflection longer than 64,000 characters is cut and says so. PENpi does
  not choose what to keep; the start of the text is kept.
