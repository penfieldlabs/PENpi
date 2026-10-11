# 30. Validate configuration values instead of coercing them

- Status: Accepted
- Date: 2026-10-11

## Context

`resolvePenpiConfig()` coerced whatever it found:

- `Number("")` is 0, so an empty environment variable (`export PENPI_CONTEXT_CEILING=`)
  became a ceiling of 0, clamped to 0.01: FIFO pruned on every call. The boolean variables
  had the same problem in their own way — an empty `PENPI_INJECT_BRIEFING` read as "on",
  overriding a setting of `false`.
- A setting was used as the fallback without any type check. `"contextCeiling": "abc"`
  became `NaN`, and `NaN` survives `Math.min`/`Math.max`; `"saveContextOnShutdown": "false"`
  is a truthy string.
- A fraction above 1 was clamped to 0.99. Someone writing `75` for 75% got a ceiling that
  lets the window fill completely.

## Decision

Each value comes from the first source that holds a usable one: the environment
variable, then the global setting, then the default.

- An environment variable that is empty or only whitespace is unset.
- A number must be finite. Environment variables are parsed; a setting must already be a
  JSON number. A boolean setting must be a JSON boolean.
- `contextCeiling` and `contextFloor` above 1 are rejected. Values in range are still
  clamped to [0.01, 0.99] as before, so 1 still means 0.99.
- A value that was set but rejected is reported by name on stderr, once per resolution,
  and the next source is used.

## Consequences

- No input can make a FIFO fraction `NaN`, 0.01 by accident, or 0.99 by overflow.
- A value given in the wrong form is ignored, not repaired: `"0.6"` as a string in
  settings falls back to the default (with a report) rather than being read as 0.6.
- Non-positive fractions are still clamped to 0.01, unchanged.
