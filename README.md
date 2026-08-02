<p align="center">
  <img src="assets/penpi-logo.png" alt="PENpi" width="320">
</p>

# PENpi

**PENpi is a fork of [Pi](https://pi.dev) that gives the coding agent persistent memory.**
It replaces Pi's context *compaction* with **FIFO context management** backed by
[Penfield](https://penfield.app) — so detail is never summarized away.

> Built on Pi by **Mario Zechner / Earendil** — see [Built on Pi](#built-on-pi).

## Why

Every coding agent loses context to compaction: when the window fills, an LLM
summarizes the oldest messages and the detail is gone. PENpi takes a different path —
three tiers of memory, none of which summarize anything away:

- **Tier 1 — Context window (FIFO):** the oldest messages silently roll off the back.
  Pruning is *watermarked* (drop from a ceiling back down to a floor) so the session
  rides in a healthy band instead of pinned near 100% — better for cost, and for the
  many models that degrade past ~70–80% utilization.
- **Tier 2 — Penfield:** curated, persistent memory the agent uses **deliberately**
  (`recall` / `store` / `connect` / `explore` / `reflect` / …). A knowledge graph that
  survives across sessions.
- **Tier 3 — Session transcript:** Pi's verbatim JSONL — the searchable safety net for
  everything that rolls out of Tier 1.

Messages that leave the context window are still in the transcript, and anything worth
keeping is in Penfield. Nothing important is lost.

## How it works

PENpi is a Pi **extension** (`.pi/extensions/penpi/`) plus two fork-level defaults.

**The automatic layer — four hooks:**

| Hook | What PENpi does |
|------|-----------------|
| `session_start` | Penfield `awaken()` + `reflect("recent")`, injected as an orientation briefing so the agent starts oriented |
| `context` | FIFO watermark pruning before every LLM call |
| `session_before_compact` | cancel — FIFO owns context |
| `session_shutdown` | optional `save_context()` checkpoint, then disconnect |

**The conscious layer:** Penfield's 17 MCP tools are exposed to the model through
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), Pi's community MCP
integration. PENpi owns Penfield auth and shares a single JWT with the adapter, so
there is **one sign-in** for both layers and no tool-registration code of our own.
The same adapter can wire an optional web-search backend. Search is deliberately not a
PENpi core dependency or automatic install: choose a tested keyless, self-hosted, paid,
or provider-native option in [Optional web search](docs/WEB_SEARCH.md).

**Fork defaults:** compaction is **off by default** (PENpi replaces it); the Penfield
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

Configure PENpi under a `penpi` key — globally in `~/.pi/agent/settings.json`, or
per-project in `.pi/settings.json`:

```json
{
  "penpi": {
    "contextCeiling": 0.75,
    "contextFloor": 0.50,
    "saveContextOnShutdown": false
  }
}
```

## Run

PENpi is model-agnostic — any provider Pi supports. From any project directory:

```bash
cd ~/my-project
export ZAI_API_KEY=…                      # or your provider's key
pi -a --provider zai --model glm-5.2     # PENpi core: memory + FIFO
# add --penpi-raw to diagnose behavior without automatic orientation
# resume a session created elsewhere:  pi … --session <id>
# -a auto-trusts project .pi/ dirs: extensions run without a prompt and MCP
# servers inherit the Penfield bearer token. Use only on your own repos.
```

The generated `mcp.json` stays in the global agent dir (nothing is written into your
project), and a dedupe guard prevents double-loading if you also run inside this repo.
PENpi refuses to read or replace a symlink at that auth-adjacent config path.

## Development & tests

Working **on PENpi itself**? Run the fork straight from this repo (no global install needed):

```bash
./pi-test.sh                      # run the built fork from source, any directory
```


```bash
npm run check          # lint, format, type check (Pi's gate)
npm test               # all workspace tests, including the PENpi extension suite
npm test -w penpi      # just the PENpi extension tests
```

Builds use the model-catalog snapshot committed with the source, so a fixed commit has
fixed build and test inputs and does not depend on live provider catalogs. Maintainers
refresh the snapshot deliberately with `npm run generate:models`, review the generated
diff, run the full gate, and commit the catalog update as one change.

The extension is a workspace with a [Vitest](https://vitest.dev) suite covering FIFO
pruning, config precedence, MCP config generation, token management, and transcript
search. `npm run check` also type-checks and lints the extension (`check:penpi`). See
[README.pi.md](README.pi.md) for Pi's full development and supply-chain notes (all of
which PENpi follows: exact-pinned direct deps, lockfile guard, shrinkwrap, `npm audit`).

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the three-tier memory + two-layer design.
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
work. The per-LLM-call `context` hook that FIFO depends on is unique to Pi; it is *why*
we chose to build on it. PENpi adds only the Penfield memory layer.

- **Upstream:** <https://github.com/earendil-works/pi>
- **Website & docs:** <https://pi.dev>
- **Pi's own README:** [README.pi.md](README.pi.md) (upstream project reference)

If PENpi is useful to you, please support and credit the upstream Pi project.

## License

MIT. Pi is © Mario Zechner — see [LICENSE](LICENSE), preserved in full with its
attribution. PENpi's additions are © Penfield and released under the same MIT
license.
