# Roadmap

Roadmap items are design direction, not release promises.

## Normalize provider-native web search

Status: research / planned — tracked in
[GitHub issue #9](https://github.com/penfieldlabs/PENpi/issues/9).

Some model providers expose web search as a native tool. PENpi should eventually make
that usable without assuming every endpoint for a model has the same capability.

Before implementation:

- Detect support from the active provider/endpoint capabilities, not a model-name list.
- Require explicit opt-in and show provider-specific billing and data-handling implications.
- Define a search policy such as `off`, `external-mcp`, `provider-native`, or deliberate
  `auto`; never silently add a paid tool.
- Present one clear search path to the model and avoid duplicate calls when external MCP
  and native search are both available.
- Preserve source URLs, citations, query provenance, and tool errors in transcripts.
- Degrade cleanly when search is unavailable; memory, FIFO, and transcript search must
  continue independently.
- Test direct providers and aggregators, session resume, provider handoff, rate limits,
  no-results behavior, and cost reporting.

Until that contract exists, provider-native search remains provider configuration and
external MCP search remains a user-selected option. See [WEB_SEARCH.md](WEB_SEARCH.md).
