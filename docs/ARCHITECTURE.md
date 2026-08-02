# PENpi Architecture

PENpi is a fork of [Pi](../README.md) that gives the coding agent persistent memory and
replaces context compaction with FIFO management. It ships as a Pi **extension**
(`.pi/extensions/penpi/`) plus a few fork-level defaults. Every decision below has an
ADR in [docs/adr/](adr/).

## Three-tier memory ([ADR 0004](adr/0004-three-tier-memory.md))

| Tier | What | How |
|------|------|-----|
| 1 — Context window | Recent messages, the working surface | FIFO watermark pruning in the `context` hook ([ADR 0003](adr/0003-fifo-replaces-compaction.md)) |
| 2 — Penfield | Curated, cross-session memory | MCP tools, used **deliberately** by the agent |
| 3 — Transcript | Verbatim session JSONL | `search_transcript` tool ([ADR 0012](adr/0012-transcript-search-tier-3.md)) |

Nothing is summarized away: messages leaving Tier 1 remain in Tier 3, and important
things are stored to Tier 2.

## Two layers of Penfield access ([ADR 0006](adr/0006-two-layer-penfield-access.md))

- **Automatic (hooks → thin client):** `penfield-client.ts`, a small client on
  `@modelcontextprotocol/sdk`. Used by the hooks for `awaken` / `reflect` / `save_context`.
- **Conscious (LLM tools → `pi-mcp-adapter`):** Penfield's tools are exposed to the model
  by the adapter; PENpi writes zero tool-registration code for it.

Both share **one token** ([ADR 0009](adr/0009-single-shared-jwt.md)): PENpi owns auth and
hands the JWT to the adapter via `PENFIELD_JWT` + a generated `mcp.json` entry.

## Hooks (the extension)

| Hook | Behavior |
|------|----------|
| `session_start` | Connect, `awaken()` + `reflect("recent")`, cache state, inject an orientation briefing + behavioral protocol; wire the conscious layer (set `PENFIELD_JWT`, write `mcp.json`) |
| `context` | FIFO watermark pruning before every LLM call; refresh the shared token; wrapped so a fault never blocks the call |
| `session_before_compact` | Return `{cancel:true}` — FIFO owns context |
| `session_shutdown` | Optional `save_context()` checkpoint (opt-in, [ADR 0010](adr/0010-save-context-on-shutdown-opt-in.md)), then disconnect |

Plus the `/penpi` command (status + `/penpi login`) and the `search_transcript` tool.
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
advanced diagnostic control that keeps connection, tools, transcript search, and FIFO while
skipping the automatic orientation prompt layer.

## File map (`.pi/extensions/penpi/`)

| File | Responsibility |
|------|----------------|
| `index.ts` | Wires hooks, `/penpi` command, `search_transcript`, conscious-layer setup |
| `penfield-client.ts` | Thin MCP client + `TokenManager` (device-code auth and discovery) |
| `fifo.ts` | Pure `planFifo()` watermark pruner |
| `transcript-search.ts` | Pure read-only `searchTranscripts()` over session logs |
| `mcp-config.ts` | Generates the adapter's `penfield` server entry (shared JWT) |
| `config.ts` | Layered config resolvers |
| `*.test.ts` | Vitest unit tests |

## CI / quality

`npm run check` (biome + `tsgo` + supply-chain checks + `check:penpi` tsc over the
extension) and `npm test` (all workspaces incl. the extension) run on pre-commit and in
CI. See [CONTRIBUTING.md](../CONTRIBUTING.md) and [docs/TEST_PROTOCOL.md](TEST_PROTOCOL.md).
