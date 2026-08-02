# 18. Global install (run PENpi from any directory)

- Status: Accepted (web-search portion superseded by [0021](0021-optional-user-selected-web-search.md))
- Date: 2026-06-26

## Context

PENpi ships project-local to the repo: the extension lives in `.pi/extensions/penpi/`,
the adapter package + compaction setting in `.pi/settings.json`, web search in `.mcp.json`.
That only works when pi is launched from the repo. To use PENpi on other projects — e.g.
a sandbox the agent works in, isolated from PENpi's own source — it must load from any cwd.
Pi already supports global extensions (`<agentDir>/extensions/`), global settings packages,
and a global `mcp.json` (`getAgentPath("mcp.json")`); PENpi just needs its pieces placed there.

## Decision

Provide `scripts/penpi-global.sh` (install / uninstall / status) that wires PENpi into pi's
global locations, all pointing back at the repo (single source of truth):

- `~/.local/bin/pi` → symlink to the fork's built `dist/cli.js` (pi on PATH).
- `<agentDir>/extensions/penpi` → symlink to the repo extension.
- Merge into `<agentDir>/settings.json`: `pi-mcp-adapter` pin + `compaction.enabled:false`
  (never clobbers existing settings).
- Merge DuckDuckGo into `<agentDir>/mcp.json` (the adapter's canonical config).
- Add `PATH` + `PENPI_MCP_CONFIG_PATH=<agentDir>/mcp.json` to the shell profile.

Two code changes make it flawless rather than merely functional:
- `PENPI_MCP_CONFIG_PATH` override in `ensurePenfieldMcpEntry` — the runtime `penfield`
  entry is written to the global `mcp.json`, never littering the working directory.
- A process-level dedupe guard in the extension's default export — when the global copy
  and a project-local copy are both discovered (running inside the repo), it loads once.

## Consequences

- `cd <any project> && pi -a …` gives full PENpi (orientation, Penfield tools,
  web search, FIFO) with no files written into that project.
- Editing the repo updates the global install (symlinks). In-repo development still works.
- Fully reversible (`uninstall`); the repo and unrelated user settings are untouched.
- Sessions remain cwd-scoped: to resume a session created elsewhere, pass `--session <id>`.
