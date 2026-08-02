# 2. PENpi is a fork of Pi

- Status: Accepted
- Date: 2026-06-21

## Context

PENpi needs a coding-agent harness whose context window we can rewrite on every LLM
call (to implement FIFO — see [0003](0003-fifo-replaces-compaction.md)). Pi
(`earendil-works/pi`, MIT, by Mario Zechner / Earendil) is uniquely suited: it is
minimalist, fully extensible, and its `context` hook gives an extension a deep copy of
the message array before each model call — no other agent we evaluated exposes this.

## Decision

Fork Pi (MIT). Add only the Penfield memory layer — primarily as a Pi **extension**
(`.pi/extensions/penpi/`) plus a few fork-level defaults (e.g. compaction off). Preserve
Pi's identity and license in full: `LICENSE` (© Mario Zechner) is untouched, Pi's
original README is kept verbatim as `README.pi.md`, and PENpi's README credits Pi
prominently.

## Consequences

- We inherit Pi's harness, runtime, multi-provider AI layer, and TUI for free.
- We must track upstream Pi and periodically reconcile our fork.
- We carry attribution obligations; keeping the change surface small (an extension +
  minimal defaults) keeps the fork easy to reason about and re-base.
