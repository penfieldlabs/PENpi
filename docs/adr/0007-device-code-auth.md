# 7. Penfield auth via OAuth 2.1 device code flow

- Status: Accepted
- Date: 2026-06-21

## Context

PENpi runs on headless boxes (no browser). The interactive authorization-code flow needs
a browser/redirect. We need a one-time, browser-free ceremony that yields refreshable
tokens.

## Decision

Use the **device code flow (RFC 8628)** as the shipping auth path: register a client if
needed, present a `portal.penfield.app/device` URL + user code, poll, then persist and
refresh tokens locally. The ceremony is only triggered by an explicit `/penpi login` —
never from startup (which must never block). Tokens are stored at
`~/.config/penpi/penfield-tokens-prod.json` (mode 600), and refresh-token rotation is
honored (always persist the latest).

## Consequences

- One ~30s ceremony per box; no browser, no SSH tunnel.
- `getAccessToken()` is non-interactive (cached/refresh only) and throws "run /penpi
  login" rather than hanging on a ceremony.
- Endpoints are discovered, not hardcoded ([0008](0008-oauth-endpoint-discovery.md)).
