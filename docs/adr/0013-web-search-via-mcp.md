# 13. Web search via MCP

- Status: Superseded by [0021](0021-optional-user-selected-web-search.md)
- Date: 2026-06-21

## Context

An agent without web access is severely limited. We already have a conscious MCP layer
([0006](0006-two-layer-penfield-access.md)), so web search should slot into it rather
than become bespoke code we maintain.

## Decision

Add web search as another MCP server on `pi-mcp-adapter`, configured in a committed
`.mcp.json`. Default to a free, keyless **DuckDuckGo** server
(`@oevortex/ddg_search`, pinned — [0014](0014-pin-third-party-dependencies.md)); expose
only its `web-search` tool and exclude its bundled AI answer-engines (we want raw results,
not someone else's pre-summarized answer — PENpi reasons itself). Upgrading to a
higher-quality provider (Tavily/Exa/Firecrawl/…) is a one-line `.mcp.json` edit, no code.

## Consequences

- Zero new code; same layered configuration pattern as Penfield.
- Free/keyless out of the box; trivially swappable when we want quality.
