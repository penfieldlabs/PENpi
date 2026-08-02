# What the model actually sees (prompt layers)

In a PENpi session there are six layers between the model and your input. This documents
each: what it is, where it lives, and how to audit or configure it.

## Order the model receives

1. **System message** = layer A (+ appends) + B + C + F, assembled by
   `packages/coding-agent/src/core/system-prompt.ts` (`buildSystemPrompt`).
2. **Injected context message** = layer E — PENpi's orientation, a hidden (`display:false`)
   user message added at `session_start`, so it precedes your first prompt.
3. **Your conversation** — user prompts, assistant turns, tool results.
4. Tool definitions (layer D) travel with the request, not the prompt text.

## The layers

| # | Layer | Default | Where it lives | How to change |
|---|-------|---------|----------------|---------------|
| A | Pi system prompt ("You are an expert coding assistant operating inside pi…" + guidelines + a Pi-docs section) | on | `packages/coding-agent/src/core/system-prompt.ts` | `--system-prompt "<text>"` replaces the base; `--append-system-prompt "<text>"` appends |
| B | Project context files injected as `<project_instructions>` | `AGENTS.md` / `CLAUDE.md` from cwd + ancestors + global | `core/resource-loader.ts` (`loadProjectContextFiles`); the files themselves | `--no-context-files` / `-nc` |
| C | Skills + prompt templates | auto-discovered | `~/.pi/agent/…`, `.pi/…`, settings | `--no-skills` / `-ns`, `--no-prompt-templates` / `-np` |
| D | Tool snippets/guidelines (one line per tool: builtins, `mcp` proxy, `search_transcript`, …) | on (per active tool) | each tool's `promptSnippet` / `promptGuidelines` | `--no-tools` / `-nt`; `--tools` / `-t`, `--exclude-tools` / `-xt` |
| E | **PENpi injection** — orientation briefing (Penfield `awaken`), behavioral protocol (`PENPI_PROTOCOL`), and `reflect` output | automatic when authenticated | `.pi/extensions/penpi/index.ts` (`PENPI_PROTOCOL`, `orient()`) | `displayBriefing` makes it visible; `--penpi-raw` skips this layer for diagnostics ([ADR 0016](adr/0016-prompt-layer-control.md), [ADR 0022](adr/0022-raw-diagnostic-boundary.md)) |
| F | Current date + working directory | on (2 lines) | `system-prompt.ts` (appended last) | n/a |

> Note: `--system-prompt`/`-nc`/`-ns` are Pi flags and do **not** remove layer E.
> `--penpi-raw` is PENpi's explicit diagnostic control for that layer.

> **Seeing layer E.** The briefing is injected with `display: false`, so it shapes the
> model's context without appearing in the session view. That keeps the transcript clean,
> but it also means injected memory is not visible by default — set
> `penpi.displayBriefing: true` (or `PENPI_DISPLAY_BRIEFING=1`) in your **global**
> `.pi/settings.json` to render it and audit exactly what is reaching the model.
> `/penpi` reports the current state as `briefing shown|hidden`.
> Layer E is a *message*, not part of the system prompt.

> **Persistent-memory authority boundary.** Penfield is trusted persistent context: its
> established preferences, decisions, and history should be used. Like any long-lived
> memory, an entry may be stale or quote an old instruction. The neutral boundary markers
> preserve the memory as context while stating that remembered text cannot override current
> system/developer/user instructions or independently authorize actions. Use
> `displayBriefing` to audit it and `update_memory` by ID to correct a bad record. Penfield
> currently exposes no delete tool through PENpi.

## Raw diagnostic mode

`--penpi-raw` connects and authenticates normally and retains Penfield MCP tools,
`search_transcript`, FIFO, and compaction cancellation. It skips automatic `awaken`,
`reflect`, `PENPI_PROTOCOL`, and the orientation message. This isolates the automatic
memory prompt layer when diagnosing model behavior; it is not the normal operating mode.

Because the automatic orientation is absent, memory manually recalled through tools is
ordinary tool output and does not receive the persistent-memory boundary above. Raw mode is
therefore not a remedy for poisoned memory: inspect/correct the record, then retest normally.

## Seeing it for yourself

The exact assembled request can be dumped via the `before_provider_request` extension
hook (`event.payload.messages`, in order). See [docs/TEST_PROTOCOL.md](TEST_PROTOCOL.md).
