# 16. Prompt-layer transparency and a raw-model switch

- Status: Accepted
- Date: 2026-06-21

## Context

We must be able to run the bare model with full control over what shapes it — especially
for non-Anthropic models where injected personas/instructions can degrade behavior.
PENpi injects its own layer into the context (the Penfield `awaken` persona, the
behavioral `PENPI_PROTOCOL`, and `reflect` output) as a hidden message at
`session_start`. Pi's own flags (`--system-prompt`, `--no-context-files`, …) control
Pi's layers but cannot remove PENpi's injection, and the full set of layers was not
documented anywhere.

## Decision

1. **Document every layer** the model receives — what it is by default, where it lives,
   and how to change it — in [docs/PROMPT_LAYERS.md](../PROMPT_LAYERS.md).
2. **Add a raw switch** for PENpi's own layer: `injectBriefing` config (default on),
   overridable by `PENPI_INJECT_BRIEFING=false`, `penpi.injectBriefing: false`, or the
   `--penpi-raw` flag (precedence: flag > env > settings > default). In raw mode PENpi
   injects nothing (no briefing/protocol/persona); the conscious-layer tools and FIFO
   still function.

## Consequences

- The bare model is reachable and controllable; the assembled context is no longer a
  black box.
- `--penpi-raw` composes with Pi's flags (e.g. `--system-prompt`, `-nc`, `-ns`) to strip
  down to exactly what the operator chooses.
- One more config knob, covered by tests and the layered-config precedence ([ADR 0015](0015-layered-configuration.md)).
