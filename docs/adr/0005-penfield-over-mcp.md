# 5. Integrate Penfield over MCP, not a custom REST client

- Status: Accepted
- Date: 2026-06-21

## Context

Penfield exposes both a REST API and an MCP server. A prior project integrated Penfield
via a bespoke REST client and ended up in a constant update loop chasing Penfield's API
changes. We want PENpi to ride Penfield's improvements without that treadmill.

## Decision

Integrate Penfield over **MCP**. Penfield maintains the MCP server; PENpi speaks the
standard protocol. New Penfield tools appear via `tools/list` and are picked up
generically. The only Penfield-specific code is the handful of tools the hooks call
deliberately (awaken / reflect / save_context).

## Consequences

- We track the protocol (stable), not Penfield's REST surface (churny).
- Penfield feature additions are available with little or no PENpi change.
- Auth and transport follow the MCP/OAuth standards (see 0006–0009).
