# PENpi Test Protocol

Two layers of testing: **automated** (run always, hermetic) and **manual/live** (run on
release and whenever an auth/hook/tool path changes, since they need external services).

## Automated (CI + local)

### Release gate — the exact sequence, from a clean checkout

```bash
npm ci                 # install from the committed lockfile
npm run build          # REQUIRED before check/test — see note
npm run check          # biome lint/format + tsgo + supply-chain checks + check:penpi (extension tsc)
npm test               # all workspace tests
npm test -w penpi      # just the PENpi extension suite
npm audit --omit=dev   # production advisories — must be clean
npm audit              # including dev advisories — must be clean
```

**`npm run build` is not optional.** `@earendil-works/pi-coding-agent` resolves through
`packages/coding-agent/dist`, which does not exist in a fresh checkout. Without it,
`npm run check:penpi` and `npm test -w penpi` fail with
`Failed to resolve entry for package "@earendil-works/pi-coding-agent"`.

**Install with `npm ci`, not `npm install`.** Regenerating the lockfile from scratch
currently crashes npm 10.x in this workspace (`Cannot read properties of null (reading
'edgesOut')`). The committed lockfile is the source of truth; `npm ci` is what CI runs.

**One `npm ci` warning is expected and not a gate failure:**

```text
EBADENGINE Unsupported engine: @earendil-works/gondolin@0.12.0
           required: {"node":">=23.6.0"}  current: {"node":"v22.19.0"}
```

The documented source install includes Gondolin as an upstream example workspace
(`packages/coding-agent/examples/extensions/gondolin`), which causes the expected
Node-engine warning. PENpi and Pi core do not import or load it during normal execution,
and coding-agent's runtime shrinkwrap/install-lock exclude it. The repo supports Node
>=22.19.0; that example alone wants >=23.6.0, and npm warns once at install time.

It is left in place deliberately. Deleting an upstream example workspace would add
divergence to merge against for the planned Pi 0.84.2 integration, in exchange for
silencing a warning about a workspace that is not part of the runtime. Revisit when that
upgrade lands — either the example's engine requirement will have moved, or it can be
dropped as part of a change that is already reconciling upstream.

### Developer quick checks

Once you already have a built tree, `npm run check` / `npm test` / `npm test -w penpi`
are enough for an edit-test loop. All must be green before commit (husky) and in CI.
Unit tests use fixtures only — they **never** touch real session logs or live network.

Covered by unit tests: `planFifo` (watermarks/edge cases), config precedence,
`mcp-config` generation, `TokenManager` (single-flight and device-login guard),
`searchTranscripts`.

## Manual / live

Run from the repo (full PENpi loads). **Never** delete or mutate session logs or other
working directories.

Prereqs: a model key (e.g. `ZAI_API_KEY` for `--provider zai --model glm-5.2`), Penfield
reachable. Use `PENPI_DEBUG=1` to see hook activity.

### 1. Device-code login
```bash
PENPI_DEBUG=1 node packages/coding-agent/dist/cli.js -a --provider zai --model glm-5.2
# in pi:
/penpi login
```
Expect: a `portal.penfield.app/device?user_code=…` prompt → approve → "login complete
and oriented". Token persists at `~/.config/penpi/penfield-tokens-prod.json` (mode 600).
Relaunch should auto-orient with no login.

### 2. Orientation
On startup (authenticated), expect `awaken` + `reflect` to run and an orientation briefing
injected. `/penpi` shows `connected=true` and an oriented timestamp.

### 3. Conscious layer — Penfield tools
Ask the agent to `recall`/`search`/`store`. Expect the adapter to connect to Penfield with
the shared JWT and return real data. The persistence loop: store something → quit →
relaunch → recall it.

### 4. Optional web search
If a backend is configured, follow [WEB_SEARCH.md](WEB_SEARCH.md): run at least three
varied searches, one content fetch, a clean no-results case, and a private-address refusal
test. If none is configured, confirm PENpi starts normally without a search tool. Search
failure must not affect Penfield, FIFO, or transcript search.

### 5. Tier-3 transcript search
Ask for something said in an earlier session that FIFO dropped. Expect `search_transcript`
to find it in the session logs.

### 6. FIFO
With a long conversation crossing the ceiling, expect oldest messages to drop to the floor
(watch `PENPI_DEBUG=1` `[PENpi] FIFO: …`). Orientation/injections survive.

### 7. Graceful degradation
With Penfield unreachable **or slow**, expect startup to skip cleanly within the request
timeout (default 15s, `PENPI_PENFIELD_TIMEOUT_MS`; [ADR 0017](adr/0017-fast-fail-timeouts.md)) —
no hang — with FIFO still working and tool errors surfaced (not a crash). If optional web
search is configured, it should remain independent of the Penfield failure.

### 8. Raw diagnostic mode (`--penpi-raw`)
Ask once normally and once with `--penpi-raw`: "is there a Penfield orientation briefing in
your context? ORIENT-YES or ORIENT-NO." Expect **`ORIENT-YES`** normally and
**`ORIENT-NO`** in raw mode. At byte level, normal mode has one current `penpi-briefing`
message with `BEGIN/END PENFIELD PERSISTENT MEMORY` markers; raw mode has none. Confirm raw
mode still connects and retains Penfield tools, transcript search, FIFO, and compaction
cancellation while making no automatic `awaken` or `reflect` call. See
[PROMPT_LAYERS.md](PROMPT_LAYERS.md).
