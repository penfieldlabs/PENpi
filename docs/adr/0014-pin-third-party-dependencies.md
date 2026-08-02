# 14. Pin third-party dependencies exactly

- Status: Accepted
- Date: 2026-06-21

## Context

PENpi depends on third-party code we do not control — notably `pi-mcp-adapter` (the
conscious layer) and the DuckDuckGo MCP server. An unpinned dependency resolves to
*latest* at install time, so an upstream release can silently break us. The repo's own
supply-chain policy already requires exact-pinned direct external dependencies.

## Decision

Pin every external dependency to an exact version and update it consciously:

- `pi-mcp-adapter@2.10.0` in `.pi/settings.json` (the package spec, which travels).
- `@oevortex/ddg_search@1.2.2` in `.mcp.json`.
- `@modelcontextprotocol/sdk` exact in the extension's `package.json`.

Upgrades are deliberate: bump the version, run the gate + tests, and (if it's an
architectural change) record an ADR.

## Consequences

- Reproducible installs; no surprise breakage from upstream releases.
- We carry the (small) cost of periodic, intentional dependency bumps.
