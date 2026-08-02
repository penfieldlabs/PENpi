# Changelog

All notable changes to **PENpi**. Format: [Keep a Changelog](https://keepachangelog.com/).
PENpi versioning starts at `0.1.0`. (Pi core has its own changelog at
`packages/coding-agent/CHANGELOG.md`.)

## [0.1.0] — 2026-07-31

### Added
- FIFO context management replacing compaction; watermark ceiling/floor pruning in the
  `context` hook. [ADR 0003]
- Three-tier memory model: context window (FIFO) / Penfield / session transcript. [ADR 0004]
- Penfield integration over MCP: a thin client for hooks + `pi-mcp-adapter` for
  LLM-facing tools, sharing one token. [ADR 0005, 0006, 0009]
- OAuth 2.1 **device-code** auth (RFC 8628) with `.well-known` endpoint discovery
  (RFC 9728 + 8414). [ADR 0007, 0008]
- `session_start` orientation (awaken + reflect, injected briefing + behavioral protocol).
- `/penpi` command (status; `/penpi login` for device-code auth).
- `search_transcript` Tier-3 tool over the session JSONL logs. [ADR 0012]
- Optional, user-selected web search through MCP, with a tested keyless DuckDuckGo
  configuration plus self-hosted, paid, and provider-native alternatives documented in
  `docs/WEB_SEARCH.md`. No search provider is installed by PENpi core. [ADR 0021]
- CI now type-checks and lints the PENpi extension (`check:penpi` + biome).
- `displayBriefing` config / `PENPI_DISPLAY_BRIEFING` env (default `false`) renders the
  injected orientation briefing in the UI as well. In normal mode the model is oriented;
  this controls only whether the **user** also sees it. Default stays hidden (clean session
  view); turn it on to audit exactly what memory is being injected. `/penpi` shows the state.
- `--penpi-raw` / `injectBriefing` advanced diagnostic control: connect normally and retain
  Penfield tools, transcript search, FIFO, and compaction cancellation while skipping
  automatic `awaken`, `reflect`, protocol, and orientation injection. [ADR 0016, 0022]
- `docs/PROMPT_LAYERS.md` documents every prompt layer and the exact raw-mode boundary.
- Fast-fail timeouts on all Penfield calls (default 15s, `PENPI_PENFIELD_TIMEOUT_MS`) so a
  slow/unreachable Penfield can't hang startup. [ADR 0017]
- Hermetic hook tests: `penpiCore(pi, deps)` dependency injection lets `index.test.ts`
  drive session_start/context/compaction/shutdown with a fake `pi` + stub client.
- Global install: `scripts/penpi-global.sh install|uninstall|status` runs PENpi from any
  directory (symlinks to the repo + global settings). `PENPI_MCP_CONFIG_PATH`
  keeps the generated mcp.json global (no working-dir litter); a dedupe guard prevents
  double-load when the global + project-local copies coexist. [ADR 0018]

### Changed
- Compaction **off by default** in the fork. [ADR 0003]
- `save_context` on shutdown is **opt-in** (default off). [ADR 0010]
- Extension state moved out of module scope into `penpiCore`'s closure (reentrant; clean
  DI boundary); the conscious-layer mcp.json writer is injectable (tests don't touch disk).
- `search_transcript` streams session logs line-by-line instead of reading whole files.
- `session_start` warns if `pi-mcp-adapter` is missing (conscious layer unavailable;
  orientation + FIFO still work).
- Disabled the upstream-pi "Update Available" banner — a fork must not steer users to
  `pi update` (which would replace it with stock pi). [ADR 0019]
- Hardened binary-release automation: manual builds accept only an existing version tag
  whose commit is on base `main`; arbitrary source refs are no longer accepted.
- Published accepted initial-release risks and mitigations in `docs/KNOWN_LIMITATIONS.md`.
- Committed the generated provider model-data snapshot and made normal builds offline and
  deterministic. Live catalog refresh is now an explicit `npm run generate:models`
  maintenance operation whose generated diff is reviewed and committed deliberately.

### Removed
- The npm publish pipeline (`publish-npm` job, `scripts/publish.mjs`, and the `publish` /
  `publish:dry` npm scripts). It targeted upstream's `@earendil-works/*` package names,
  which are not ours, so it could never run successfully — fork debris, and a
  `workflow_dispatch` away from publishing over upstream's packages. PENpi is distributed
  via `scripts/penpi-global.sh` and the Build Binaries workflow.
- Inherited upstream issue-management and model-catalog publication workflows that are not
  part of PENpi. In particular, PENpi no longer carries a workflow capable of publishing
  Pi's model catalog with repository credentials.
- Internal external-review instructions, frozen multi-model review protocol, and agent
  self-test handoff document. The public live `docs/TEST_PROTOCOL.md` remains.
- Upstream-only contributor auto-close documentation, allowlist, and package-report issue
  form after removing the workflows that implemented that process.
- The issue-analysis session importer and Pi R2 model-catalog publisher, which had no PENpi
  workflow or release role.

### Security
- Updated the MCP SDK and affected transitive dependencies to patched versions; the npm
  dependency audit and isolated recommended-DDG environment report no known advisories.
- Project `.pi/settings.json` can no longer supply Penfield **credentials or file paths**
  (sensitive Penfield settings are global-only). PENpi reads that file itself, outside
  pi's project-trust gate, so an untrusted repo could otherwise
  authenticate the agent to an attacker's Penfield account — exfiltrating stored context
  and injecting attacker-controlled memory — or relocate the OAuth refresh token into the
  repo tree. Non-sensitive behavior settings still apply.
- OAuth discovery now requires **https** and a host within the configured Penfield domain
  before any device code or refresh token is posted to it (RFC 9728 §3.3 / RFC 8414 §3.3);
  a compromised resource document can no longer redirect credentials off-domain.
- The documented `pi -a` invocation now carries an explicit warning: `-a` auto-trusts
  project `.pi/` directories, so a cloned repo's `.pi/extensions/*.ts` loads without a
  prompt. Penfield credentials and sensitive paths are global-only, so this is a
  project-code-execution tradeoff to
  make per machine — drop `-a` on any box where you open untrusted repos.
  Note: project-defined MCP servers (`.pi/mcp.json`) inherit the agent's
  `PENFIELD_JWT` environment variable. Shell commands are scrubbed (see
  `shell.ts`), but MCP server processes are not. This is a known limitation —
  the trust prompt (or `-a`) is the gate. Do not auto-trust repos you haven't
  read.
- `mcp.json` is written via tmp+rename and a **parse error is no longer treated as an
  empty file** — a hand-edited or concurrently-written config can't be silently replaced,
  dropping other MCP servers. The token directory is created `0700`.
- `penpi-global.sh` refuses to overwrite a non-symlink `pi`/extension path (an existing
  upstream install), and `uninstall` only removes links pointing into this repo.
- CI workflow declares `permissions: contents: read`.
- The global installer now rejects malformed/wrong-shaped/symlinked settings instead of
  replacing or silently ignoring them, and updates valid settings atomically while
  preserving unrelated fields.
- Penfield's generated `mcp.json` now defaults to the global agent directory regardless of
  cwd and refuses symlinks, preventing a hostile repository from redirecting auth-adjacent
  writes into its tree.
- Automatic Penfield orientation/reflection has a neutral persistent-memory authority
  boundary: use remembered preferences, decisions, and history, but remembered text cannot
  override current instructions or independently authorize actions.

### Fixed
- Global uninstall validates its shell-profile markers before changing anything and removes
  only a complete bounded block; a missing END marker can no longer erase the rest of an rc
  file. Install also starts its managed block on a new line when the existing rc file has no
  trailing newline, keeping the block detectable and uninstallable.
- Failed Penfield connects and tool calls clear client state, so `/penpi` no longer reports
  `connected=true` after transport or authentication failure.
- Small-context FIFO prioritizes the newest live turn and drops an orientation briefing when
  retaining both would exceed its pruning budget.
- FIFO now prunes whenever provider-reported usage exceeds the ceiling even when the learned
  overhead cap leaves PENpi's own estimate below it.
- **FIFO now triggers on the greater of its candidate-list estimate and pi's reported
  context usage.** The `context` hook is call-scoped — the session's message list is never
  mutated — while `getContextUsage()` can reflect the *pruned* context last sent. Depending
  on either metric alone could miss an overflow; the report also teaches the otherwise
  invisible system-prompt/tool-definition overhead.
- Only the most recent orientation briefing is FIFO-protected; resuming a session N times
  no longer pins N stale briefings (with contradictory "recent" reflections) in the window.
- `search_transcript` searches every session log for the project, the live one included:
  under FIFO the messages that rolled out of the window are in the *current* transcript,
  which is exactly what Tier 3 exists to reach. Full, unfiltered access is the feature.
- `penpi-global.sh uninstall` also removes the `compaction.enabled=false` override it
  added, so stock pi is left with working context management.
- `PENPI_MCP_CONFIG_PATH=""` falls through to the default path instead of failing.
- FIFO: an assistant tool-call message and its toolResult messages now drop or stay as
  one atomic unit, so a prune boundary can never orphan a tool result (orphaned results
  are rejected by provider APIs; pi only synthesizes results for orphaned *calls*).
- `penpi-global.sh`: the `PENPI_MCP_CONFIG_PATH` written to the shell rc now honors
  `PI_CODING_AGENT_DIR` instead of hardcoding `~/.pi/agent`.
- Config: watermarks can no longer invert when `contextCeiling` is set below 0.1.
- Device-code polling reports a non-JSON token-endpoint response (e.g. a proxy error
  page) as a clean error instead of a raw `SyntaxError`; `PenfieldClient.connect()`
  closes any previous transport instead of leaking it.
- Refresh-token persistence: a refresh response that omits `refresh_token`/`clientId` no
  longer nulls the stored values — auth survives the first token refresh. Covered by tests.
- Cross-platform global install: `penpi-global.sh` detects the shell rc (bash/zsh/fish) and
  removes its managed block portably (no GNU-only `sed -i`) — works on macOS.
- `authFetch` typed as `typeof fetch` (no unsafe cast); carries headers when the SDK passes
  a `Request` object instead of `(url, init)`.
- Device-code `verification_uri_complete` is OPTIONAL (RFC 8628) — fall back to
  `verification_uri` so the prompt never shows `undefined`.
- Token store written with mode `0o600` on create, closing the chmod TOCTOU window.
- Adapter-installed check now inspects pi's managed npm dirs (`.pi/npm`, agent-dir npm)
  instead of `require.resolve` (which always failed) — no more false "pi-mcp-adapter not
  found" warning every session when the adapter is in fact loaded.

### Security
- Bumped `@modelcontextprotocol/sdk` to `1.29.0` (clears a ReDoS advisory).
- Exact-pinned third-party deps: `pi-mcp-adapter@2.10.0`, `@oevortex/ddg_search@1.2.2`. [ADR 0014]

### Notes
- Built on Pi (MIT, © Mario Zechner / Earendil). See [README.md](README.md).
