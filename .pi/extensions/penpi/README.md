# PENpi extension

Penfield persistent memory + FIFO context management for [Pi](https://pi.dev).
This directory is the PENpi extension; see the [repo README](../../../README.md) for
the project overview and the [architecture description](../../../docs/ARCHITECTURE.md).

## Files

| File | Responsibility |
|------|----------------|
| `index.ts` | Entry point — wires the four hooks, the `/penpi` command, and the conscious-layer setup |
| `penfield-client.ts` | Thin MCP client over `@modelcontextprotocol/sdk` + device-code `TokenManager` |
| `fifo.ts` | Pure `planFifo()` watermark pruner |
| `config.ts` | Layered config (defaults ← `settings.json` `penpi` ← env); exports `BRIEFING_CUSTOM_TYPE` |
| `mcp-config.ts` | Generates the `pi-mcp-adapter` server entry so the conscious layer shares our JWT |
| `*.test.ts` | Vitest suite (run with `npm test -w penpi`) |

## The four hooks (automatic layer)

- **`session_start`** — connect to Penfield, `awaken()` + `reflect("recent")`, cache via
  `pi.appendEntry`, and inject an orientation briefing (+ a behavioral protocol) into the
  agent's context with `pi.sendMessage` (`display: false` — hidden from the user, present
  for the model). Also sets `PENFIELD_JWT` and writes the adapter's `mcp.json`.
- **`context`** — `planFifo()` before every LLM call: when usage exceeds the ceiling,
  drop the oldest non-protected messages down to the floor. PENpi injections are
  protected; the newest message is always kept; order is preserved. After three
  consecutive triggers PENpi warns once per session that history is aging out of the
  window and durable facts belong in Penfield. Wrapped in try/catch so a fault can never
  block the call.
- **`session_before_compact`** — reason-aware. Cancels routine `threshold` compaction
  (FIFO owns context) and cancels when no reason is given; allows `overflow` (a single
  atomic unit too large for the window, which FIFO cannot shrink) and `manual` (an
  explicit `/compact` is user intent). See
  [ADR 0023](../../../docs/adr/0023-overflow-compaction-escape-hatch.md).
- **`session_shutdown`** — optional `save_context()` checkpoint (skipped on hot-reload),
  then disconnect.

## Conscious layer

Penfield's tools are exposed to the model by [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter),
not by us. At `session_start` PENpi sets `PENFIELD_JWT` and writes a `penfield` server
entry (`auth: "bearer"`, `bearerTokenEnv: PENFIELD_JWT`) into `.pi/mcp.json`. Because the
adapter resolves the bearer once per connection, PENpi keeps the env token fresh (in the
`context` hook) and sets `idleTimeout` so the connection recycles and re-reads it. One
token, one sign-in, zero tool-registration code on our side.

**Web search** can be wired through the same adapter, but is optional and user-selected.
PENpi does not install a provider or require an account. See
[`docs/WEB_SEARCH.md`](../../../docs/WEB_SEARCH.md) for the tested keyless option,
self-hosted and paid alternatives, configuration, and security pitfalls.

## Auth

`TokenManager` uses the OAuth 2.1 device code flow (RFC 8628):
  register a client if needed, prompt the user with a `portal.penfield.app/device` URL,
  poll, then persist + refresh. No browser on the host.

The thin client injects a fresh token on every request via a custom `fetch`; the
adapter picks up refreshes on reconnect.

## Configuration

`settings.json` under a `penpi` key (env vars override):

| settings.json | env var | default | meaning |
|---------------|---------|---------|---------|
| `penfield.clientId` | `PENPI_PENFIELD_CLIENT_ID` | — | OAuth client id (else dynamically registered) |
| `penfield.tokenStore` | `PENPI_PENFIELD_TOKEN_STORE` | `~/.config/penpi/penfield-tokens-prod.json` | device-code token store |
| `contextCeiling` | `PENPI_CONTEXT_CEILING` | `0.75` | FIFO trigger fraction of the context window |
| `contextFloor` | `PENPI_CONTEXT_FLOOR` | `0.50` | FIFO drains to this fraction (forced below ceiling) |
| `saveContextOnShutdown` | `PENPI_SAVE_CONTEXT_ON_SHUTDOWN` | `false` | `save_context()` on shutdown (opt-in; env `=true`/`1` to enable) |
| `injectBriefing` | `PENPI_INJECT_BRIEFING` | `true` | advanced diagnostic control for automatic orientation; normally leave enabled (`--penpi-raw` disables it for one session) |
| `displayBriefing` | `PENPI_DISPLAY_BRIEFING` | `false` | also **show** normal automatic orientation in the UI. It does not change model context; set `true` to audit exactly what memory is injected each session |
| `mcpLifecycle` | `PENPI_MCP_LIFECYCLE` | `lazy` | adapter connection lifecycle. `lazy` prevents warm-profile connections before PENpi publishes `PENFIELD_JWT`; explicit overrides are advanced and `eager` can reintroduce the startup race |

Other env: `PENPI_DEBUG=1` (verbose hook logging); `PENFIELD_JWT` (set by PENpi for the
adapter — do not set manually).

## Flags & commands

- **`--penpi-raw`** — advanced diagnostic mode: connect and keep Penfield tools,
  transcript search, and FIFO active, but skip automatic `awaken`, `reflect`, orientation,
  and memory-protocol injection. Manually recalled memory remains ordinary tool output.
- **`/penpi`** — status: Penfield auth/connection, automatic orientation, and FIFO.
- **`/penpi login`** — run the Penfield device-code login (RFC 8628).

## Testing

```bash
npm test -w penpi
```

Pure logic (`planFifo`, config precedence, `mcp-config`, `TokenManager` exchange &
single-flight) is unit-tested with mocked fetch — no network or live Penfield required.

## Credit

PENpi is a fork of [Pi](https://pi.dev) by Mario Zechner / Earendil (MIT). The
extension system and the per-LLM-call `context` hook this builds on are Pi's. The
conscious layer uses [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter).
