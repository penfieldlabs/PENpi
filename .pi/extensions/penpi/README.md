# PENpi extension

Penfield persistent memory + the context engine for [Pi](https://pi.dev).
This directory is the PENpi extension; see the [repo README](../../../README.md) for
the project overview and the [architecture description](../../../docs/ARCHITECTURE.md).

## Files

| File | Responsibility |
|------|----------------|
| `index.ts` | Entry point — wires PENpi's hooks, the `/penpi` command, the context engine, and the conscious-layer setup |
| `penfield-client.ts` | Thin MCP client over `@modelcontextprotocol/sdk` + device-code `TokenManager` |
| `engine/` | The context engine: planner, estimator, limits, recovery, header and pin, settings, telemetry, and the `context_notes` / `context_search` / `context_recall` tools and `doctor` command ([docs/CONTEXT_ENGINE.md](../../../docs/CONTEXT_ENGINE.md)) |
| `engine-only.ts` | Loads the context engine alone, without Penfield, MCP or orientation (the benchmark entry) |
| `config.ts` | Layered config (defaults ← global `settings.json` `penpi` ← env); exports `BRIEFING_SECTION` (and `BRIEFING_CUSTOM_TYPE`, the 0.4 message type) |
| `mcp-config.ts` | Builds the embedded `pi-mcp-adapter` config (global `mcp.json` only) and its `penfield` entry, so the conscious layer shares our JWT |
| `*.test.ts` | Vitest suite (run with `npm test -w penpi`) |

## The hooks (automatic layer)

- **`session_start`** — connect to Penfield, `awaken()` + `reflect("recent")`, cache via
  `pi.appendEntry`, and build the orientation briefing (+ a behavioral protocol). Also sets
  `PENFIELD_JWT` and writes the adapter's `mcp.json`.
- **`before_agent_start`** — put the briefing into the system prompt as the
  `<penpi-memory>` section, on every run. It is never a message, so it stays in view after
  the context engine cuts, and the text stays the same for the session (ADR 0032).
- **`context`** — refresh the shared Penfield token before every LLM call.
- **`session_shutdown`** — optional `save_context()` checkpoint (skipped on hot-reload),
  then disconnect.

The context engine (`engine/`) registers its own hooks: `context_with_system` plans each
request (cuts above 75% of the input budget down to 45%, adds the header),
`before_provider_request` caps the requested output, `message_end` / `turn_end` /
`agent_before_settle` calibrate, learn limits, retry overflows and continue after an
output-limit stop, `session_before_compact` cancels every compaction (a manual `/compact`
moves the window forward), and `session_before_tree` replaces `/tree` summaries with a fixed
notice. See [docs/CONTEXT_ENGINE.md](../../../docs/CONTEXT_ENGINE.md) and
[ADR 0032](../../../docs/adr/0032-context-engine.md).

## Conscious layer

Penfield's tools are exposed to the model by [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter),
not by us. PENpi embeds the adapter (a pinned dependency) and installs it through
`createMcpAdapter({ config })`, with a config built from the global `mcp.json` only plus a
`penfield` server entry (`auth: "bearer"`, `bearerTokenEnv: PENFIELD_JWT`). The adapter
reads no config files of its own in that mode, so a project's `.mcp.json` and
`.pi/mcp.json` are ignored ([ADR 0026](../../../docs/adr/0026-global-only-configuration.md)).
At `session_start` PENpi sets `PENFIELD_JWT` and also persists the `penfield` entry to the
global `mcp.json`. A stock `pi-mcp-adapter` package still listed in pi's settings would
load a second copy that does read project config; PENpi warns about it. Because the
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

The global `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) under a
`penpi` key; env vars override. A project `.pi/settings.json` is never read for these.
An empty env var counts as unset. A value of the wrong type is reported and the next
source is used ([ADR 0030](../../../docs/adr/0030-strict-config-values.md)).

| settings.json | env var | default | meaning |
|---------------|---------|---------|---------|
| `penfield.clientId` | `PENPI_PENFIELD_CLIENT_ID` | — | OAuth client id (else dynamically registered) |
| `penfield.tokenStore` | `PENPI_PENFIELD_TOKEN_STORE` | `~/.config/penpi/penfield-tokens-prod.json` | device-code token store |
| `saveContextOnShutdown` | `PENPI_SAVE_CONTEXT_ON_SHUTDOWN` | `false` | `save_context()` on shutdown (opt-in; env `=true`/`1` to enable) |
| `injectBriefing` | `PENPI_INJECT_BRIEFING` | `true` | advanced diagnostic control for automatic orientation; normally leave enabled (`--penpi-raw` disables it for one session) |
| `displayBriefing` | `PENPI_DISPLAY_BRIEFING` | `false` | also **show** normal automatic orientation in the UI. It does not change model context; set `true` to audit exactly what memory is injected each session |
| `mcpLifecycle` | `PENPI_MCP_LIFECYCLE` | `lazy` | adapter connection lifecycle. `lazy` prevents warm-profile connections before PENpi publishes `PENFIELD_JWT`; explicit overrides are advanced and `eager` can reintroduce the startup race |

The context engine's settings (`windowCeiling`, `highWater` / `lowWater`, `limitOverrides`,
`pinUserMessages` and the rest) go in the same `penpi` block and have no env vars; see
[docs/CONTEXT_ENGINE.md](../../../docs/CONTEXT_ENGINE.md#settings). PENpi 0.4's FIFO settings
(`contextFloor`, `contextCeiling`, `emergencyCompactionRuns`) and their env vars are no
longer read; PENpi warns at startup when one is set.

Other env: `PENPI_DEBUG=1` (verbose hook logging); `PENPI_ENGINE_LOG=<path>` (the context
engine's log, off by default); `PENFIELD_JWT` (set by PENpi for the adapter — do not set
manually).

## Flags & commands

- **`--penpi-raw`** — advanced diagnostic mode: connect and keep Penfield tools,
  transcript search, and the context engine active, but skip automatic `awaken`, `reflect`,
  orientation, and memory-protocol injection. Manually recalled memory remains ordinary tool output.
- **`/penpi`** — status: Penfield auth/connection, automatic orientation, and whether the
  context engine is installed.
- **`/penpi login`** — run the Penfield device-code login (RFC 8628).
- **`/penpi doctor`** — the context engine's effective window and output limit and where
  they come from, the cut band, the calibration ratio, learned limits with their evidence,
  answers produced from truncated input, and the settings that apply.
- **`/penpi reset-limits`** — forget the windows and output limits the engine learned in
  this session.

## Testing

```bash
npm test -w penpi
```

Pure logic (config precedence, the context engine's settings, entry points and telemetry,
`mcp-config`, `TokenManager` exchange & single-flight) is unit-tested with mocked fetch — no
network or live Penfield required. The engine's behaviour suites run against a real Pi
session in `packages/coding-agent/test/suite/` (see
[docs/CONTEXT_ENGINE.md](../../../docs/CONTEXT_ENGINE.md#tests)).

## Credit

PENpi is a fork of [Pi](https://pi.dev) by Mario Zechner / Earendil (MIT). The
extension system and the per-LLM-call context hooks this builds on are Pi's. The
conscious layer uses [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter).
