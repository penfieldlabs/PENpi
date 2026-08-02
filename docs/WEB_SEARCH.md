# Optional web search

Web search is useful, but it is not part of PENpi's memory core. PENpi therefore does
not install a search provider or require a search account. Add one to Pi's MCP config if
you want it; PENpi preserves that configuration during install and uninstall.

The global MCP file is `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json`. Merge a server
into its existing `mcpServers` object. Do not replace the file: it can contain Penfield
and other user-managed servers.

## Recommended keyless option: DuckDuckGo with browser fallback

Our tested option is `duckduckgo-mcp-server[browser]==0.6.1`. Its normal backend is
lightweight; when DuckDuckGo rejects that request, `auto` falls back to a browser-like
TLS client. In our release check, 8/8 MCP calls completed (seven result sets and one
clean no-results response), content fetch worked, private localhost fetch was refused,
and the isolated Python environment had no known dependency advisories.

This is still an unofficial scraper of DuckDuckGo's public interface—not a supported
DuckDuckGo API. It can break again, be rate-limited, or encounter a CAPTCHA. Pinning a
tested release makes changes deliberate; it cannot guarantee an upstream website will
remain compatible.

Install it persistently with [uv](https://docs.astral.sh/uv/guides/tools/):

```bash
uv tool install 'duckduckgo-mcp-server[browser]==0.6.1'
```

Then merge this entry into the global `mcp.json`:

```json
{
  "mcpServers": {
    "duckduckgo": {
      "command": "duckduckgo-mcp-server",
      "args": ["--search-backend", "auto", "--fetch-backend", "auto"],
      "directTools": ["search", "fetch_content"]
    }
  }
}
```

If the executable is not on the environment's `PATH`, use its absolute path. For a uv
installation, `uv tool dir --bin` shows the tool directory. A Python virtual environment
is equally valid; point `command` at that environment's executable.

To ask an agent to configure it, use this prompt from the PENpi repository:

> Read `docs/WEB_SEARCH.md`. Merge the pinned recommended DuckDuckGo backend into my
> global Pi MCP config. Preserve every existing server and property. Verify the
> executable, run three varied searches and one content fetch, and confirm a private
> localhost URL is refused. Do not expose credentials.

Remove it by deleting only `mcpServers.duckduckgo`. PENpi's uninstaller intentionally
leaves user-managed search entries alone.

## Why the original default was removed

PENpi's original pre-release configuration used `@oevortex/ddg_search@1.2.2` because it
was free, keyless, small, and easy to launch with `npx`. It queried DuckDuckGo's HTML
endpoint. That endpoint later began returning HTTP 202 challenge responses to the
package's request fingerprint. In our 0.83.0 release test, the old MCP server returned
useful results in 0/3 searches. It had no browser-fingerprint fallback, so retries did
not repair it.

That failure was not in Penfield, FIFO, Pi, or DuckDuckGo's documented product: it was a
fragile, unofficial integration with a changing public website. Automatically installing
one such provider made unrelated upstream behavior look like a PENpi core failure.

Search is optional now because the correct choice depends on account policy, budget,
privacy, reliability, deployment, and model provider. The MCP boundary still makes it
easy to add or replace a backend without changing PENpi.

## Choices

| Choice | Signup | Money | Main trade-off |
|---|---:|---:|---|
| Tested DuckDuckGo scraper above | No | No direct fee | Easiest keyless option, but unofficial and inherently breakable |
| Self-hosted SearXNG | No for your users | Free software; hosting costs | More control and backend diversity; you operate and secure it |
| Public SearXNG instance | Usually no | Usually free | Instance may log queries, rate-limit, disappear, or disable JSON |
| Brave Search API | Yes; API key | Quota/metered plan | Supported search API and independent index; account required |
| Tavily | Yes; API key | Quota/metered plan | Agent-oriented search/extraction; account and vendor dependency |
| Exa | Yes; API key | Metered | Strong semantic retrieval; account and vendor dependency |
| Firecrawl | Yes; API key | Metered | Strong crawling/extraction; more than a simple search replacement |
| Browser automation | No search account | Compute/operations | Broad compatibility, but heavy, slow, and CAPTCHA-prone |
| Model/provider-native search | Existing provider account | Provider/tool dependent | Convenient and often cited, but model/provider-specific |

Plans and quotas change. Check each provider's current terms before documenting a cost
promise or shipping a configuration. PENpi does not endorse or silently select one.

### What SearXNG is

[SearXNG](https://docs.searxng.org/) is open-source metasearch software that sends a
query to configured search engines and combines their results. It is not its own web
index. You can run it on your own server, choose engines, set retention and network
policy, and expose its HTTP/JSON search API to an MCP adapter.

Self-hosting avoids a search-vendor signup, not operational work: deployment, updates,
TLS, abuse controls, engine breakage, rate limits, and monitoring become yours. Public
instances are useful for experiments but are a poor distribution default. Their operator
can observe queries, availability varies, and many instances disable JSON output. Follow
the official [container installation](https://docs.searxng.org/admin/installation-docker.html)
and [search API](https://docs.searxng.org/dev/search_api.html) documentation. We do not
yet designate a tested SearXNG MCP adapter; audit and pin one before recommending it.

## Pitfalls every backend shares

- Search queries and fetched URLs may reveal project information. Never send secrets,
  credentials, private source, or customer data as queries.
- Results and pages are untrusted input. They can contain prompt injection, malware links,
  deceptive citations, or poisoned instructions. Verify important claims at primary
  sources and do not let page text authorize commands or credential access.
- Content-fetch tools need SSRF protection. They must reject loopback, link-local, private,
  and cloud-metadata addresses, including redirects and DNS rebinding.
- Pin MCP packages exactly, audit dependencies, and test before upgrading. `npx`/`uvx`
  without a version can silently run different code later.
- Keep API keys in environment variables or a secret manager, not committed JSON. MCP
  child processes inherit an environment, so scope it deliberately.
- Avoid exposing both an external search tool and provider-native search under confusing
  names. The model may call both, double cost, or produce inconsistent citations.
- Test no-results, timeout, rate-limit, malformed-page, and unavailable-backend behavior.
  Search failure must degrade cleanly and must not break PENpi memory.

## Model/provider-native web search

Do not turn it on merely because a model name is known to support search. Availability,
tool schema, billing, citations, and data handling can differ by provider and route; the
same model through an aggregator may not expose the same capability.

For now, configure native search according to the model provider and treat it as separate
from PENpi. A normalized, capability-detected interface is a roadmap item. It should be
explicitly enabled, disclose cost/privacy implications, preserve citations, and avoid
registering a duplicate external search tool. See [ROADMAP.md](ROADMAP.md).
