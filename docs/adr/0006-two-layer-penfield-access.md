# 6. Two-layer Penfield access (thin client + adapter)

- Status: Accepted
- Date: 2026-06-21

## Context

Penfield must be reachable in two different ways: (a) **programmatically** from PENpi's
hooks (e.g. `session_start` calls awaken/reflect; shutdown calls save_context), and
(b) as **LLM-facing tools** the model can invoke. `pi-mcp-adapter` (a community Pi
extension) exposes MCP servers as tools, but it does not give another extension a
programmatic client — and the hooks need code-level calls.

## Decision

Two layers:

- **Automatic layer — our thin client** (`penfield-client.ts`, ~1 file on
  `@modelcontextprotocol/sdk`): used by the hooks for awaken/reflect/save_context.
- **Conscious layer — `pi-mcp-adapter`**: exposes Penfield's tools to the model. We write
  zero tool-registration code for it; we configure it ([0009](0009-single-shared-jwt.md)).

We deliberately did **not** fork/adopt the adapter for the hooks (its surface is large
and LLM-tool-oriented); a thin client is the right primitive for programmatic calls.

## Consequences

- Hooks get a clean `client.recall()/store()/…` handle; the model gets first-class tools.
- Two connections to the same server — reconciled by sharing one token ([0009](0009-single-shared-jwt.md)).
- We own a small, stable MCP client; we depend on the adapter (pinned, [0014](0014-pin-third-party-dependencies.md)).
