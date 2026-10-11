# 26. PENpi and its MCP adapter take configuration from global files only

- Status: Accepted
- Date: 2026-10-11

## Context

PENpi reads its own configuration directly, outside pi's project-trust gate. Two
configuration paths let the working directory change PENpi's behaviour:

- **F5: PENpi settings.** `loadPenpiSettings()` merged the `penpi` block of the
  project's `.pi/settings.json` over the global settings. Credentials and file paths
  were already stripped from the project layer, but everything else applied. That let a
  repository switch the Penfield environment, turn off orientation, force
  `mcpLifecycle: "eager"` (which brings back the 401 race described in mcp-config.ts), or
  set a context ceiling low enough to prune every turn.
- **F1: MCP servers.** The conscious layer is pi-mcp-adapter, installed as a stock pi
  package. Its `loadMcpConfig()` merges `~/.config/mcp/mcp.json`, the Pi global
  `mcp.json`, the project's `.mcp.json` and the project's `.pi/mcp.json`, and the project
  files win. A repository could therefore add MCP servers, including stdio servers (local
  commands, started at load when `lifecycle: "eager"`), or replace existing ones, including
  `penfield`. PENpi's own code never read these files; the adapter did. The adapter's
  `configPath` option does not help, because the project layers are applied on top of
  whatever file it names.

## Decision

Both are global-only.

- **Settings.** `loadPenpiSettings()` reads only `<agentDir>/settings.json`. A `penpi`
  block in the project's `.pi/settings.json` is ignored, with one warning naming the file.
  When `PI_CODING_AGENT_DIR` points at `<cwd>/.pi` the two paths are the same file, and it
  is treated as global.
- **MCP.** PENpi embeds the adapter: `pi-mcp-adapter` becomes a pinned dependency of the
  extension, and PENpi installs it on its own `ExtensionAPI` through
  `createMcpAdapter({ config })`. In that mode the adapter reads no configuration files.
  `buildAdapterConfig()` builds the config from the global `mcp.json` alone (honouring
  `PENPI_MCP_CONFIG_PATH`) plus PENpi's `penfield` entry. The stock package is removed from
  the repository's `.pi/settings.json`, `penpi-global.sh install` removes it from the global
  settings, and PENpi warns at `session_start` if pi's settings still list it.

Three details are load-bearing:

- **The `penfield` entry is built in memory.** The adapter takes its config once, at
  extension load. On a clean profile that is before `session_start` has written the entry
  to disk, so reading it back from the file would leave the first session without
  Penfield tools. The entry is still persisted to the global file for visibility.
- **The adapter is installed after PENpi's handlers.** pi runs one extension's handlers
  in registration order, and the adapter's `session_start` must follow PENpi's, which
  publishes `PENFIELD_JWT`. Installing the adapter at the end of `penpiCore` keeps the
  order the two separate extensions used to have.
- **`--penpi-dev` is read from argv when building the config.** pi applies extension flag
  values only after every extension has loaded, so `pi.getFlag()` still returns the
  default at that point. The adapter reads its own `--mcp-config` from argv for the same
  reason. PENpi warns if the session's Penfield URL differs from the adapter's.

Failures never stop PENpi loading. A bad global `mcp.json` (unparseable, wrong shape, or a
symbolic link) yields a config with only the `penfield` entry, and an adapter that fails to
load leaves PENpi running without the conscious layer. Both are reported at
`session_start`.

## Consequences

- A repository can no longer configure PENpi or add MCP servers by being the working
  directory. The integration suite proves the MCP half with eager stdio servers in both
  project files, whose commands would leave marker files if either file were read; with
  the stock adapter's default config the test fails.
- The adapter's `/mcp setup`, `/mcp enable` and `/mcp disable` commands are unavailable:
  the adapter disables them when its config is supplied programmatically. Servers are
  managed by editing the global `mcp.json` and running `/reload`.
- The adapter's `--mcp-config <path>` flag is silently ignored. The adapter still
  registers it, so it is listed in `pi --help`, but a supplied config takes precedence
  over it and nothing reports that the path was not read. `PENPI_MCP_CONFIG_PATH` is the
  supported way to point PENpi at a different global `mcp.json`.
- `~/.config/mcp/mcp.json` and the `imports` feature (other hosts' MCP configs) are no
  longer read.
- Per-project PENpi settings are no longer possible. Environment variables still override
  the global settings for a single invocation.
- The adapter and its dependencies are now production dependencies, so they count in
  `npm audit --omit=dev`.
- Users who installed an earlier PENpi keep the stock package in their global settings
  until they re-run `scripts/penpi-global.sh install` or remove it; until then pi loads
  both copies, and the stock copy still reads project config. PENpi warns on every
  session start while that is the case.
