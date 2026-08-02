# 21. Make web search optional and user-selected

- Status: Accepted
- Date: 2026-08-01
- Supersedes: [0013](0013-web-search-via-mcp.md), and the web-search portion of
  [0018](0018-global-install.md)

## Context

PENpi's pre-release configuration selected `@oevortex/ddg_search@1.2.2` because it was
free, keyless, and fit the existing MCP layer. It scraped DuckDuckGo's public HTML
endpoint rather than using a supported API. During the 0.83.0 release test, DuckDuckGo
returned HTTP 202 challenge responses and the server produced useful results in 0/3
searches. The package had no browser-fingerprint fallback.

Search providers differ in account requirements, cost, privacy, operational burden, and
reliability. A failure in an automatically installed third-party scraper also appeared to
users as a failure of PENpi's unrelated memory core.

## Decision

PENpi core and its global installer do not install or select a web-search backend. Search
remains an optional MCP capability configured by the user. Install and uninstall never
modify user-managed search servers.

Document tested keyless, self-hosted, paid API, browser, and provider-native choices with
their trade-offs. Pin and test any recommended package. Our current keyless recommendation
is `duckduckgo-mcp-server[browser]==0.6.1`, whose automatic browser-like fallback passed
the release checks, while retaining the warning that any unofficial scraper can break.

Provider-native search is a roadmap item requiring capability detection, explicit opt-in,
cost/privacy disclosure, citation preservation, and duplicate-tool avoidance.

## Consequences

- A fresh PENpi install has no web search until the user chooses one.
- Penfield memory, FIFO, and transcript search do not depend on a search website.
- Existing user-managed MCP configuration survives install and uninstall.
- Public distribution avoids imposing an account, billable vendor, or search privacy
  policy, at the cost of one documented configuration step for users who want search.
- Recommended search integrations require ongoing release testing and can be replaced
  independently of PENpi core.
