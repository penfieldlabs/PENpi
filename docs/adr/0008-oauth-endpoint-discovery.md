# 8. Discover OAuth endpoints via .well-known

- Status: Accepted
- Date: 2026-06-21

## Context

The first device-login implementation hardcoded endpoint paths (`/oauth/register`, …)
from a docs snippet. The live server actually serves them under `/api/v2/oauth/…`, so
login 404'd. OAuth/MCP auth is meant to be discovered, not assumed.

## Decision

Always discover endpoints, never hardcode. Follow the full standard chain:

1. **RFC 9728** — the MCP resource's `/.well-known/oauth-protected-resource` advertises
   its `authorization_servers`.
2. **RFC 8414** — that server's `/.well-known/oauth-authorization-server` advertises
   `registration_endpoint`, `device_authorization_endpoint`, `token_endpoint`.

Fall back to the configured auth host's metadata only if step 1 is unavailable. This is a
standing engineering rule (follow the spec/docs), not a one-off.

## Consequences

- Resilient to Penfield moving or versioning its endpoints.
- Slightly more network at first login (cached thereafter).
- Generalizes: any future MCP server we add authenticates the same standard way.
