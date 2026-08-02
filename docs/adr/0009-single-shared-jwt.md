# 9. One shared token across both layers

- Status: Accepted
- Date: 2026-06-21

## Context

Both the thin client and the conscious-layer adapter ([0006](0006-two-layer-penfield-access.md))
talk to the same Penfield server. Authenticating each independently would mean two
sign-ins / two token stores for one service — ugly and confusing.

## Decision

PENpi owns all Penfield auth and shares **one** token. At `session_start` it obtains the
JWT (via [0007](0007-device-code-auth.md)) and hands it to the adapter by setting
`PENFIELD_JWT` in the environment and writing a `penfield` server entry
(`auth: "bearer"`, `bearerTokenEnv: PENFIELD_JWT`) into the adapter's `mcp.json`. The
adapter resolves the bearer once per connection, so PENpi keeps the env token fresh (in
the `context` hook) and sets `idleTimeout` so the connection recycles and re-reads it.
The thin client injects a fresh token per request via a custom `fetch`.

## Consequences

- One login covers both layers; zero tool-registration code on our side.
- A token captured at session start covers the session unless it outlives the token
  (24–72h), handled by the periodic env refresh + connection recycling.
