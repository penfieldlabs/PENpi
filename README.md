<p align="center">
  <img src="assets/penpi-logo.png" alt="PENpi" width="320">
</p>

# PENpi

**PENpi is a fork of [Pi](https://pi.dev) that gives the coding agent persistent memory.**
It replaces Pi's context *compaction* with the **context engine** and keeps durable memory
in [Penfield](https://penfield.app) — so your work isn't summarized away.

> Built on Pi by **Mario Zechner / Earendil** — see [Built on Pi](#built-on-pi).

## Why

Every coding agent loses context to compaction: when the window fills, an LLM
summarizes the oldest messages and the detail is gone. PENpi takes a different path —
three tiers of memory, none of which summarize your work away:

- **Tier 1 — Context window (the context engine):** when a request would cross 75% of
  the input budget, the engine cuts at a turn boundary so it falls to 45%, and the oldest
  messages leave the model's view. The cut persists, which keeps the provider's prompt
  cache, and the session rides in a healthy band instead of pinned near 100%, which suits
  the many models that degrade past ~70–80% utilization. On cost it is neutral, not a
  saving: in the PENpi-bench release gate, measured on the 0.5.0 code (b5211ed48), 2026-10-26,
  the billed cost per filler step was about the same as stock Pi's ($0.0038 against $0.0037). A header after each cut carries your
  earlier messages verbatim and says how to get the rest back
  (`context_search` / `context_recall`). See [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md).
- **Tier 2 — Penfield:** curated, persistent memory the agent uses **deliberately**
  (`recall` / `store` / `connect` / `explore` / `reflect` / …). A knowledge graph that
  survives across sessions.
- **Tier 3 — Session transcript:** Pi's verbatim JSONL — the searchable safety net for
  everything that rolls out of Tier 1.

Messages that leave the context window are still in the transcript verbatim and remain
searchable; anything worth keeping durably belongs in Penfield.

**No compaction exception.** The engine cancels every compaction request, overflow
included. One tool result or user message may use at most 25% of the input budget, and
the rest stays recallable. An overflow error is retried with a smaller window (at most 3
times per run), and the engine learns the real window from it. A manual `/compact` moves
the window forward instead of summarizing. See [ADR 0032](docs/adr/0032-context-engine.md).

## How it works

PENpi is a Pi **extension** (`.pi/extensions/penpi/`) plus two fork-level defaults.

**The automatic layer — memory hooks plus the context engine:**

| Hook | What PENpi does |
|------|-----------------|
| `session_start` | Penfield `awaken()` + `reflect("recent")`, built into an orientation briefing so the agent starts oriented |
| `before_agent_start` | puts the briefing into the system prompt, so it stays in view after the context engine cuts |
| `context` | keeps the shared Penfield token fresh before every LLM call |
| `session_shutdown` | optional `save_context()` checkpoint, then disconnect |

The context engine (`.pi/extensions/penpi/engine/`) registers its own hooks:

| Hook | What the engine does |
|------|----------------------|
| `context_with_system` | plans every request: cuts at a turn boundary when it would cross 75% of the input budget, and adds the header |
| `before_provider_request` | caps the requested output to what the window leaves |
| `message_end`, `turn_end`, `agent_before_settle` | calibration, learned limits, overflow retries and up to 3 continuations after an output-limit stop |
| `session_before_compact` | cancels every compaction; a manual `/compact` moves the window forward instead |
| `session_before_tree` | a fixed notice instead of a `/tree` summary |

See [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md) for what the engine does and how to inspect it.

**The conscious layer:** Penfield's 17 MCP tools are exposed to the model through
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), Pi's community MCP
integration. PENpi owns Penfield auth and shares a single JWT with the adapter, so
there is **one sign-in** for both layers and no tool-registration code of our own.
PENpi runs the adapter itself, with the global `~/.pi/agent/mcp.json` as its only config:
a project's `.mcp.json` or `.pi/mcp.json` is never read, so a repository you open cannot
add or replace MCP servers ([ADR 0026](docs/adr/0026-global-only-configuration.md)). As a
result the adapter's `/mcp` setup and enable/disable commands are unavailable; edit the
global file and `/reload` instead. Do not also install the `pi-mcp-adapter` package — PENpi
warns if it finds one, and `scripts/penpi-global.sh install` removes it.
The same adapter can wire an optional web-search backend. Search is deliberately not a
PENpi core dependency or automatic install: choose a tested keyless, self-hosted, paid,
or provider-native option in [Optional web search](docs/WEB_SEARCH.md).

**Fork defaults:** compaction is **off by default** (the context engine replaces it, and
refuses to run while `compaction.enabled` is `true`); the Penfield
MCP server is wired automatically.

The automatic layer keeps memory effortless; the conscious layer makes it available
when the agent chooses to be deliberate. Both matter.

See [`.pi/extensions/penpi/README.md`](.pi/extensions/penpi/README.md) for the full
extension reference, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the public
architecture description.

## Auth (Penfield)

PENpi authenticates to Penfield with the OAuth 2.1 **device code flow** (RFC 8628):
one ceremony, one local token store, shared by both layers — no browser on the box, no
SSH tunnel.

```bash
pi
/penpi login                 # authenticate with Penfield using the device-code flow
```

## Install

Clone, build, and install — this is the **default install**: it makes `pi` available on
your PATH and wires PENpi (extension + conscious layer) into Pi's global config, so it
works from **any directory**.

Requires Node.js 22.19 or newer, npm, and Git. The complete development/release gate also
requires `ripgrep` (`rg`) and `fd` 8.7.0+ on `PATH` (`ripgrep` + `fd-find` on
Debian/Ubuntu; `ripgrep` + `fd` with Homebrew). Debian's package installs the command as
`fdfind`, so add an `fd` symlink in a directory on `PATH` when needed. Check `fd --version`:
Debian stable may provide 8.6.0, which is too old for the inherited suite. Use a short
absolute checkout path as well; see [known limitations](docs/KNOWN_LIMITATIONS.md).

```bash
npm ci --ignore-scripts           # reproducible workspace deps from package-lock.json
npm run build                     # build the Pi packages
scripts/penpi-global.sh install   # install PENpi globally (pi on PATH; extension + config wired)
source ~/.bashrc                  # pick up PATH + env (installer prints YOUR rc: .zshrc/.bashrc/fish)
```

Verify with `scripts/penpi-global.sh status`; remove cleanly with
`scripts/penpi-global.sh uninstall`. The install points back at this clone (single source
of truth), so the repo must stay on disk; editing it updates the install. See
[ADR 0018](docs/adr/0018-global-install.md). Web search is an optional post-install
choice; the installer preserves user-managed MCP servers.

## Upgrade

PENpi does not auto-update or consult Pi's upstream release feed. Upgrade the source
checkout deliberately. Start with a clean worktree; if `git status --short` prints
anything, preserve or commit that work before continuing.

```bash
cd /path/to/PENpi
git status --short
git pull --ff-only
npm ci --ignore-scripts
npm run build
scripts/penpi-global.sh install
scripts/penpi-global.sh status
```

The final `install` refreshes PENpi's managed links and settings without replacing
user-managed MCP servers. Provider credentials, Penfield tokens, settings, and session
transcripts remain in their existing user directories. Review the release notes and run
the [live test protocol](docs/TEST_PROTOCOL.md) when an upgrade changes Pi core, auth,
hooks, or tool integration.

Configure PENpi under a `penpi` key in the global `~/.pi/agent/settings.json`. PENpi
settings are global-only: a `penpi` block in a project's `.pi/settings.json` is ignored,
with a warning, so a repository you open cannot reconfigure PENpi.

```json
{
  "penpi": {
    "saveContextOnShutdown": false,
    "windowCeiling": 200000
  }
}
```

The context engine's settings live in the same `penpi` block. `windowCeiling` (default
200,000) caps the window the engine plans against; the cut band, the per-unit cap and the
other engine settings are listed in [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md#settings).
PENpi 0.4's FIFO settings (`contextFloor`, `contextCeiling`, `emergencyCompactionRuns`)
are no longer read; PENpi warns at startup when one is set.

## Run

PENpi is model-agnostic — any provider Pi supports. From any project directory:

```bash
cd ~/my-project
export ZAI_API_KEY=…                      # or your provider's key
pi --provider zai --model glm-5.2        # PENpi core: memory + context engine
# add --penpi-raw to diagnose behavior without automatic orientation
# resume a session created elsewhere:  pi … --session <id>
```

PENpi itself loads from the global agent dir, so it needs no project trust. Do not use
`pi -a` (`--approve`): it trusts every project's `.pi/` directory without asking, so a
repository's own extensions run inside PENpi with access to your Penfield token file.

The generated `mcp.json` stays in the global agent dir (nothing is written into your
project), and a dedupe guard prevents double-loading if you also run inside this repo.
PENpi refuses to read or replace a symlink at that auth-adjacent config path.

## Development & tests

Working **on PENpi itself**? Run the fork straight from this repo (no global install needed):

```bash
./pi-test.sh                      # run the built fork from source, any directory
```


Quick checks, once you already have a built tree:

```bash
npm run check          # lint, format, type check (Pi's gate)
npm test               # all workspace tests, the PENpi extension suite and the context engine suite
npm test -w penpi      # just the PENpi extension tests
npm run test:context-engine   # just the context engine suite
```

**From a clean checkout, build first.** `@earendil-works/pi-coding-agent` resolves
through `packages/coding-agent/dist`, which does not exist until you build — without it
`npm run check:penpi` and `npm test -w penpi` fail with
`Failed to resolve entry for package "@earendil-works/pi-coding-agent"`. The full release
gate is:

```bash
npm ci                 # install from the lockfile (see note below)
npm run build          # required — creates the dist/ that check:penpi and the penpi suite resolve
npm run setup:tokenizers   # once: the pinned tokenizers the context engine suite counts with
npm run check
npm test
npm test -w penpi
npm audit --omit=dev   # production advisories
npm audit              # including dev advisories
npm audit signatures --omit=dev   # registry signatures/attestations
```

**`npm test` needs the tokenizers.** The context engine suite counts tokens with real
tokenizers (o200k_base and GLM-5.3-Flash). `npm run setup:tokenizers` installs them once, from
the npm registry and huggingface.co, into a git-ignored directory of the repository, pinned by
hash; without it the suite stops with a message naming that command.

> Install with `npm ci`, not `npm install`. Regenerating the lockfile from scratch
> currently crashes npm 10.x in this workspace (`Cannot read properties of null (reading
> 'edgesOut')`); `npm ci` installs from the committed lockfile and is what CI uses.

Builds use the model-catalog snapshot committed with the source, so a fixed commit has
fixed build and test inputs and does not depend on live provider catalogs. Maintainers
refresh the snapshot deliberately with `npm run generate:models`, review the generated
diff, run the full gate, and commit the catalog update as one change.

The extension is a workspace with a [Vitest](https://vitest.dev) suite covering config
precedence, the context engine's settings and entry points, MCP config generation, token
management, and transcript search. The engine's behaviour suites run against a real Pi
session ([docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md#tests)). `npm run check` also
type-checks and lints the extension (`check:penpi`). See
[README.pi.md](README.pi.md) for Pi's full development and supply-chain notes (all of
which PENpi follows: exact-pinned direct deps, lockfile guard, generated install lock, `npm audit`).

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the three-tier memory + two-layer design.
- **[docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md)** — how the context window is managed, its settings and diagnostics.
- **[docs/PROMPT_LAYERS.md](docs/PROMPT_LAYERS.md)** — everything the model sees, including orientation and raw diagnostic mode.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records (the "why" behind every choice).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — workflow, the gate, ADR/test expectations.
- **[docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md)** — automated + manual/live test steps.
- **[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)** — accepted initial-release limitations and mitigations.
- **[CHANGELOG.md](CHANGELOG.md)** — notable changes.
- **[AGENTS.md](AGENTS.md)** — rules for humans and agents working on PENpi.
- **[.pi/extensions/penpi/README.md](.pi/extensions/penpi/README.md)** — extension reference + config table.

(Pi's [README](README.pi.md) and [development rules](AGENTS.pi.md) are retained for
reference and attribution, with upstream-only repository process removed.)

## Built on Pi

PENpi exists **because of [Pi](https://pi.dev)** and stands entirely on it.

Pi is the minimalist, self-extensible coding agent by **Mario Zechner**
([@badlogicgames](https://x.com/badlogicgames)) at **[Earendil](https://earendil.com)**.
Everything that makes PENpi possible — the agent harness, the runtime, the unified
multi-provider AI layer, the TUI, and especially the **extension system** — is Pi's
work. The per-LLM-call context hooks the context engine depends on are unique to Pi; they are
*why* we chose to build on it. PENpi adds the Penfield memory layer and the context engine.

- **Upstream:** <https://github.com/earendil-works/pi>
- **Website & docs:** <https://pi.dev>
- **Pi's own README:** [README.pi.md](README.pi.md) (upstream project reference)

If PENpi is useful to you, please support and credit the upstream Pi project.

## License

MIT. Pi is © Mario Zechner — see [LICENSE](LICENSE), preserved in full with its
attribution. PENpi's additions are © Penfield and released under the same MIT
license.
