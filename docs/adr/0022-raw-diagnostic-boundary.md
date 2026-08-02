# 22. Raw mode is an orientation diagnostic

- Status: Accepted
- Date: 2026-08-01
- Clarifies: [ADR 0016](0016-prompt-layer-control.md)

## Context

ADR 0016 introduced `--penpi-raw` and the underlying `injectBriefing` control, but called
the result a "bare model." That description was imprecise. Raw mode still authenticates and
connects to Penfield, exposes conscious memory tools, provides transcript search, runs FIFO,
and cancels compaction. It skips only PENpi's automatic orientation prompt layer.

Security review also showed why raw mode must not be presented as a poisoned-memory remedy:
automatic orientation and its memory-authority boundary are absent, while manually invoked
memory tools remain available.

## Decision

Retain `--penpi-raw` as an advanced diagnostic mode. Define it exactly as: connect normally,
but skip automatic `awaken`, `reflect`, `PENPI_PROTOCOL`, state/briefing injection, and UI
orientation success. Keep Penfield tools, transcript search, FIFO, and compaction
cancellation active. Document that manually recalled memory is ordinary tool output and is
not wrapped by the automatic persistent-memory boundary.

Normal PENpi remains automatically oriented. `displayBriefing` remains the audit control
for normal orientation. The persistent-memory wrapper uses neutral language: Penfield is
trusted context, while remembered text cannot override current instructions or independently
authorize actions.

## Consequences

- Raw mode can isolate whether automatic orientation is influencing model behavior.
- The name is retained for compatibility, but user-facing documentation calls it a raw
  diagnostic/no-automatic-orientation mode rather than a bare model.
- Raw mode is not recommended for ordinary use or memory remediation.
- Tests assert both what raw mode skips and what it retains.
