# 24. Neutralize forged memory fences by pattern removal, scoped to marker words

- Status: Accepted
- Date: 2026-08-09

## Context

`session_start` orientation ([ADR 0004](0004-three-tier-memory.md)) injects Penfield
briefing and reflection text into the model's context inside a delimited trust wrapper:

```
=== BEGIN PENFIELD PERSISTENT MEMORY ===
...briefing / reflection...
=== END PENFIELD PERSISTENT MEMORY ===
```

The wrapped content is **untrusted**. Anything the user — or anything the agent was ever
convinced to `store` — put into Penfield arrives here verbatim. A memory whose body
contains the closing fence forges the end of the block and smuggles the remainder of
itself outside the wrapper, where it reads as operator-level text rather than as recalled
memory. This is a plain delimiter breakout, and persistent memory makes it durable: the
payload is written once and replays into every subsequent session.

The first fix rewrote runs of `=` at the start of a line. That rule is correct but
insufficient, and it fails on the path most memory content actually travels: `reflect()`
returns a **JSON blob**, so a stored memory's newlines arrive as the two characters `\`
and `n`, not as line breaks. Nothing in that payload is ever at the start of a line, a
line-anchored rule matches nothing at all, and the forged fence reaches the model
untouched. Verified live against a dev Penfield instance: with a fence planted in a
stored memory, the sanitizer returned its input unchanged.

Two alternatives were considered and rejected:

- **A per-session nonce in the fence.** Rejected because an LLM is a perceptual reader,
  not a parser. A forged fence carrying the wrong nonce still *looks* like a fence.
  Removing the pattern beats labelling it.
- **Blanket replacement of every `===`.** Rejected because stored memories routinely
  contain source code, and `===` is JavaScript strict equality. A blanket rule corrupts
  the very content the memory system exists to preserve.

## Decision

Sanitize by removing the pattern, in three passes, at the injection boundary only:

1. Runs of `=` at the start of a line, on real newlines.
2. Runs of `=` following a JSON-escaped newline (`\` + `n`), which covers the `reflect()`
   payload shape.
3. Runs of `=` abutting the wrapper's own marker words anywhere in a line, which covers
   mid-line forgeries.

Passes 2 and 3 are **scoped to the fence labels**, so ordinary `===` in stored code is
left alone. Only a run of `=` actually positioned to impersonate a fence is touched.

The labels live in one exported list, `FENCE_LABELS`. `orient()` builds its fence lines
from it and the sanitizer derives its match pattern from it, so the wrapper and its
defence cannot drift apart. A first cut hand-wrote the pattern separately and immediately
proved the hazard: it omitted `PENpi MEMORY PROTOCOL`, leaving that fence forgeable
mid-line. A test iterates `FENCE_LABELS` directly, so adding a fence without the
sanitizer covering it fails the suite rather than shipping a silent hole.

Runs are replaced character-for-character with `≡` (U+2261), so the text keeps its length
and offsets into it remain valid. `≡` is visually near-identical and semantically inert.

Sanitization applies to what is **injected**. The session state entry keeps the RAW text,
storing the injected variant alongside when sanitization changed anything — Tier-3 search
must return what Penfield actually holds, and an audit must be able to see both what was
stored and what the model received.

## Consequences

- Delimiter forgery is neutralized on every shape a fence currently reaches us in,
  including the JSON-encoded path where the original rule was inert.
- Stored source code survives intact; strict-equality operators are not rewritten.
- Scoping to the fence labels would normally create a maintenance obligation — change a
  fence, remember to change its matcher. Deriving both from `FENCE_LABELS` removes that
  obligation rather than documenting it, which is why the list is the decision here and
  not an implementation detail.
- Residual gap: homoglyph and fullwidth variants (`＝＝＝`, U+FF1D) are **not** neutralized.
  By this ADR's own "perceptual reader" reasoning a fullwidth forgery still looks like a
  fence, so this is a real limitation rather than a theoretical one. It is not closed here
  because Unicode confusable folding across the whole memory payload is a materially
  larger change with its own corruption risk; it is recorded as known and deliberate.
- Sanitization is one layer, not the boundary itself. The injected protocol separately
  instructs the model that memory is context which may contain quoted prior instructions,
  does not override current system/developer/user instructions, and does not authorize
  actions on its own ([ADR 0016](0016-prompt-layer-control.md)). Defence in depth: the
  fence rule makes the *structure* unforgeable; the protocol governs *authority*.
