# Architecture Decision Records

Every significant architecture or engineering decision in PENpi is recorded here as an
ADR. Rationale: decisions must survive turnover, be reviewable, and hold up to outside
scrutiny — not live only in chat logs or someone's head.

**Format:** [Michael Nygard's](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions.html)
— one decision per file, `NNNN-kebab-title.md`, with Context / Decision / Consequences.
**Lifecycle:** ADRs are immutable once `Accepted`. To change a decision, add a new ADR
that supersedes the old one (and mark the old one `Superseded by NNNN`).
**Process:** any change that makes an architectural decision adds or updates an ADR in
the same PR (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

| #    | Title | Status |
|------|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-penpi-is-a-fork-of-pi.md) | PENpi is a fork of Pi | Accepted |
| [0003](0003-fifo-replaces-compaction.md) | Replace compaction with FIFO context management | Accepted |
| [0004](0004-three-tier-memory.md) | Three-tier memory model | Accepted |
| [0005](0005-penfield-over-mcp.md) | Integrate Penfield over MCP, not a custom REST client | Accepted |
| [0006](0006-two-layer-penfield-access.md) | Two-layer Penfield access (thin client + adapter) | Accepted |
| [0007](0007-device-code-auth.md) | Penfield auth via OAuth 2.1 device code flow | Accepted |
| [0008](0008-oauth-endpoint-discovery.md) | Discover OAuth endpoints via .well-known | Accepted |
| [0009](0009-single-shared-jwt.md) | One shared token across both layers | Accepted |
| [0010](0010-save-context-on-shutdown-opt-in.md) | save_context on shutdown is opt-in | Accepted |
| [0012](0012-transcript-search-tier-3.md) | Tier-3 transcript search tool | Accepted |
| [0013](0013-web-search-via-mcp.md) | Web search via MCP | Superseded by 0021 |
| [0014](0014-pin-third-party-dependencies.md) | Pin third-party dependencies exactly | Accepted |
| [0015](0015-layered-configuration.md) | Layered configuration precedence | Accepted |
| [0016](0016-prompt-layer-control.md) | Prompt-layer transparency and a raw-model switch | Accepted |
| [0017](0017-fast-fail-timeouts.md) | Fast-fail timeouts on Penfield calls | Accepted |
| [0018](0018-global-install.md) | Global install (run PENpi from any directory) | Accepted |
| [0019](0019-disable-upstream-update-banner.md) | Disable the upstream-pi update banner | Accepted |
| [0020](0020-pin-managed-package-installs.md) | Pin managed package installs exactly | Accepted |
| [0021](0021-optional-user-selected-web-search.md) | Optional, user-selected web search | Accepted |
| [0022](0022-raw-diagnostic-boundary.md) | Raw mode is an orientation diagnostic | Accepted |
| [0023](0023-overflow-compaction-escape-hatch.md) | Overflow compaction is an escape hatch | Accepted |
| [0024](0024-memory-fence-sanitization.md) | Neutralize forged memory fences by pattern removal | Accepted |
| [0025](0025-compaction-fallback-without-fifo-window.md) | Emergency compaction when the model has no context window | Accepted |
| [0026](0026-global-only-configuration.md) | PENpi and its MCP adapter take configuration from global files only | Accepted |
| [0027](0027-slope-free-fifo-budget.md) | The FIFO prune budget is floor × window, with no learned calibration | Accepted |
| [0028](0028-length-continuation.md) | Continue responses cut off at the output token limit | Accepted |
| [0029](0029-sanitizer-normalization-and-bounds.md) | Normalize and bound memory text before fence sanitization | Accepted |
| [0030](0030-strict-config-values.md) | Validate configuration values instead of coercing them | Accepted |
| [0031](0031-upstream-ancestry-and-patch-manifest.md) | Record upstream ancestry and list every patch against it | Accepted |
