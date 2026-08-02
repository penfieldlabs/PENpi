# 17. Fast-fail timeouts on Penfield calls

- Status: Accepted
- Date: 2026-06-24

## Context

PENpi's Penfield calls (`getAccessToken`/discovery/`connect`/`awaken`/`reflect`/
`save_context`) had no timeouts. A *clean* failure (e.g. HTTP 530) returns fast, but a
*slow or hanging* Penfield (or network) had no bound — `session_start` could stall
indefinitely. Our own graceful-degradation guarantee ("Penfield down → startup skips
cleanly, no hang", TEST_PROTOCOL step 7) was therefore aspirational, not real.

## Decision

Bound every Penfield operation:
- Short request/response calls (`.well-known` discovery, client registration, device
  authorization, token/refresh) use `fetch` with
  `AbortSignal.timeout()` (helper `tfetch`).
- `connect()` and `callTool()` (awaken/reflect/save_context) are wrapped in `withTimeout`
  — the transport's long-lived SSE stream is deliberately **not** blanket-timed.
- Default 15s, overridable via `PENPI_PENFIELD_TIMEOUT_MS`.
- The device-code **poll** keeps its own long deadline (it is waiting for a human), but
  each poll request is still individually bounded.

`session_start` already wraps orientation in try/catch, so a timeout now degrades
gracefully (notify + continue) instead of hanging.

## Consequences

- Graceful degradation is now real: a slow/unreachable Penfield degrades within the
  timeout instead of blocking the agent.
- One tunable knob; covered by tests (`withTimeout` + an abort-on-timeout wiring test).
