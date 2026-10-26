# PENpi Architecture

PENpi is a fork of [Pi](../README.md) that gives the coding agent persistent memory and
replaces context compaction with the context engine. It ships as a Pi **extension**
(`.pi/extensions/penpi/`) plus a few fork-level defaults. Every decision below has an
ADR in [docs/adr/](adr/).

## Three-tier memory ([ADR 0004](adr/0004-three-tier-memory.md))

| Tier | What | How |
|------|------|-----|
| 1 — Context window | Recent messages, the working surface | The context engine cuts at a turn boundary in the `context_with_system` hook ([CONTEXT_ENGINE.md](CONTEXT_ENGINE.md), [ADR 0032](adr/0032-context-engine.md)) |
| 2 — Penfield | Curated, cross-session memory | MCP tools, used **deliberately** by the agent |
| 3 — Transcript | Verbatim session JSONL | `search_transcript` tool ([ADR 0012](adr/0012-transcript-search-tier-3.md)) |

Nothing is summarized away: messages leaving Tier 1 remain verbatim in Tier 3, and
important things are stored to Tier 2. When a request would cross 75% of the input budget,
the engine cuts so it falls to 45%; the cut is saved as a session entry and a header after
it carries the user's earlier messages and the model's notes. `context_search` and
`context_recall` find and read what left the window. There is no compaction fallback: the
engine cancels every compaction request. One tool result or user message is capped at 25%
of the input budget (the rest stays recallable), an overflow is retried with a smaller
window, and a model with no declared window is planned against a default of 32,768 tokens. See
[CONTEXT_ENGINE.md](CONTEXT_ENGINE.md).

## Two layers of Penfield access ([ADR 0006](adr/0006-two-layer-penfield-access.md))

- **Automatic (hooks → thin client):** `penfield-client.ts`, a small client on
  `@modelcontextprotocol/sdk`. Used by the hooks for `awaken` / `reflect` / `save_context`.
- **Conscious (LLM tools → `pi-mcp-adapter`):** Penfield's tools are exposed to the model
  by the adapter; PENpi writes zero tool-registration code for it. PENpi embeds the
  adapter and gives it a config built from the global `mcp.json` only, never the
  project's `.mcp.json` or `.pi/mcp.json` ([ADR 0026](adr/0026-global-only-configuration.md)).

Both share **one token** ([ADR 0009](adr/0009-single-shared-jwt.md)): PENpi owns auth and
hands the JWT to the adapter via `PENFIELD_JWT` + a generated `mcp.json` entry.

## Hooks (the extension)

| Hook | Behavior |
|------|----------|
| `session_start` | Connect, `awaken()` + `reflect("recent")`, cache state, build the orientation briefing + behavioral protocol; wire the conscious layer (set `PENFIELD_JWT`, write `mcp.json`) |
| `before_agent_start` | Put the briefing into the system prompt (`<penpi-memory>`) on every run, so it survives the engine's cuts |
| `agent_end` | Read `awaken()` + `reflect("recent")` again in the background; a changed briefing reaches the system prompt at the engine's next cut ([ADR 0032](adr/0032-context-engine.md)) |
| `context` | Refresh the shared token before every LLM call |
| `session_shutdown` | Optional `save_context()` checkpoint (opt-in, [ADR 0010](adr/0010-save-context-on-shutdown-opt-in.md)), then disconnect |

Plus the `/penpi` command (status, `/penpi login`, and the engine's `/penpi doctor` and
`/penpi reset-limits`) and the `search_transcript` tool.

The context engine (`engine/`) registers its own hooks:

| Hook | Behavior |
|------|----------|
| `context_with_system` | Plan each request: cut at a turn boundary above `highWater` (75%) of the input budget down to `lowWater` (45%), add the header, cap large units |
| `before_agent_start` | Record each run's prompt for the header |
| `before_provider_request` | Cap the requested output to what the window leaves |
| `message_end` / `turn_end` | Calibrate the estimate against reported usage; learn output limits; continue after an output-limit stop, at most 3 per run |
| `agent_before_settle` | Retry an overflow with a smaller window, at most 3 times per run, learning the real window |
| `session_before_compact` | Cancel every compaction; a manual `/compact` moves the window forward |
| `session_before_tree` | A fixed notice instead of a `/tree` summary |
| `session_start` / `session_tree` | Load the engine's state from the session entries |
| `input` | Record where each user message came from (for the pin); refuse to run while `compaction.enabled` is `true` |
Optional user-selected web-search servers connect through the adapter but are not part of
PENpi core ([ADR 0021](adr/0021-optional-user-selected-web-search.md)).

## Auth ([ADR 0007](adr/0007-device-code-auth.md), [0008](adr/0008-oauth-endpoint-discovery.md))

OAuth 2.1 **device code flow** (RFC 8628). Endpoints are **discovered** via
`.well-known` (RFC 9728 → 8414), never hardcoded. Tokens persist at
`~/.config/penpi/penfield-tokens-prod.json` (mode 600).

## Configuration ([ADR 0015](adr/0015-layered-configuration.md))

Precedence: CLI flag → env var → `settings.json` `penpi` key → built-in default.
Full reference: [extension README](../.pi/extensions/penpi/README.md).

## Prompt layers and raw diagnostics ([ADR 0016](adr/0016-prompt-layer-control.md), [ADR 0022](adr/0022-raw-diagnostic-boundary.md))

Everything the model receives — Pi's system prompt, project context files (`AGENTS.md`),
skills, tool snippets, **PENpi's injected orientation/protocol**, and date/cwd — is
documented in [PROMPT_LAYERS.md](PROMPT_LAYERS.md): what each layer is by default, where
it lives, and how to audit it. PENpi orients automatically by default. `--penpi-raw` is an
advanced diagnostic control that keeps connection, tools, transcript search, and the context engine while
skipping the automatic orientation prompt layer.

## File map (`.pi/extensions/penpi/`)

| File | Responsibility |
|------|----------------|
| `index.ts` | Wires hooks, `/penpi` command, `search_transcript`, the context engine, conscious-layer setup |
| `penfield-client.ts` | Thin MCP client + `TokenManager` (device-code auth and discovery) |
| `engine/` | The context engine: planner, estimator, limits, recovery, header and pin, state, settings, telemetry, and its tools (`context_notes`, `context_search`, `context_recall`, doctor) |
| `engine-only.ts` | The context engine alone, without Penfield or MCP (the benchmark entry) |
| `transcript-search.ts` | Pure read-only `searchTranscripts()` over session logs |
| `mcp-config.ts` | Generates the adapter's `penfield` server entry (shared JWT) |
| `config.ts` | Layered config resolvers |
| `*.test.ts` | Vitest unit tests |

## CI / quality

`npm run check` (biome + `tsc` + supply-chain checks + `check:penpi` tsc over the
extension) and `npm test` (all workspaces incl. the extension) run on pre-commit and in
CI. See [CONTRIBUTING.md](../CONTRIBUTING.md) and [docs/TEST_PROTOCOL.md](TEST_PROTOCOL.md).
