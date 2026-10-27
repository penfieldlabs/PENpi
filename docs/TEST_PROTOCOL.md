# PENpi Test Protocol

Two layers of testing: **automated** (run always, hermetic) and **manual/live** (run on
release and whenever an auth/hook/tool path changes, since they need external services).

## Automated (CI + local)

### Release gate — the exact sequence, from a clean checkout

```bash
npm ci                 # install from the committed lockfile
npm run build          # REQUIRED before check/test — see note
npm run check          # biome lint/format + tsc + supply-chain checks + check:penpi (extension tsc)
npm test               # all workspace tests
npm test -w penpi      # just the PENpi extension suite
npm audit --omit=dev   # production advisories — must be clean
npm audit              # including dev advisories — must be clean
npm audit signatures --omit=dev   # registry signatures/attestations — must verify
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
and coding-agent's generated install lock excludes it. The repo supports Node
>=22.19.0; that example alone wants >=23.6.0, and npm warns once at install time.

It is left in place deliberately. Deleting an upstream example workspace would add
divergence to merge against at every upstream merge, in exchange for
silencing a warning about a workspace that is not part of the runtime. Revisit at the next
upstream merge: either the example's engine requirement will have moved, or it can be
dropped as part of a change that is already reconciling upstream.

### Release / review archives

One canonical command. It builds from `git archive`, so the archive contains exactly the
tracked files at a commit — never `.git`, ignored files, session exports, dependencies or
build output. It refuses a dirty tree, asserts against a forbidden-content list, and embeds
`ARCHIVE_MANIFEST.json` recording the commit, version and generation command.

```bash
scripts/make-review-archive.sh [ref] [output]     # default: HEAD, ~/penpi-review-<sha>.zip
```

Verify a received archive:

```bash
unzip -p penpi-<tag>-source.zip ARCHIVE_MANIFEST.json   # which commit produced it
sha256sum -c SHA256SUMS                                 # integrity, run beside the assets
```

`scripts/create-source-archive.sh` and `scripts/build-binaries.sh` are **upstream Pi
helpers** and are not part of the PENpi release process: they package
`packages/coding-agent` and validate against Pi's version, so a PENpi version can never
match. PENpi releases ship source only — see `.github/workflows/release.yml`.

### Developer quick checks

Once you already have a built tree, `npm run check` / `npm test` / `npm test -w penpi`
are enough for an edit-test loop. All must be green before commit (husky) and in CI.
Unit tests use fixtures only — they **never** touch real session logs or live network.

Covered by unit tests: config precedence, the context engine's settings, entry points and
telemetry, `mcp-config` generation, `TokenManager` (single-flight and device-login guard),
`searchTranscripts`. The context engine's behaviours are covered by suites that run against
a real Pi session with a faux provider ([CONTEXT_ENGINE.md](CONTEXT_ENGINE.md#tests)).

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
in the system prompt (`<penpi-memory>`), still there after the context engine's first cut. `/penpi` shows `connected=true` and an oriented timestamp.

### 3. Conscious layer — Penfield tools
Ask the agent to `recall`/`search`/`store`. Expect the adapter to connect to Penfield with
the shared JWT and return real data. The persistence loop: store something → quit →
relaunch → recall it.

### 4. Optional web search
If a backend is configured, follow [WEB_SEARCH.md](WEB_SEARCH.md): run at least three
varied searches, one content fetch, a clean no-results case, and a private-address refusal
test. If none is configured, confirm PENpi starts normally without a search tool. Search
failure must not affect Penfield, the context engine, or transcript search.

### 5. Tier-3 transcript search
Ask for something said in an earlier session. Expect `search_transcript` to find it in
the session logs.

### 6. Context engine
Run a long conversation and watch the status line (`ctx … · req …/… · N cuts · ratio …`)
and `/penpi doctor`, or set `PENPI_ENGINE_LOG=<path>` to log each cut. Expect a cut when a
request would cross 75% of the input budget, after which the request falls to about 45%.
After a cut, expect your earlier messages to appear verbatim in the header, and
`context_search` / `context_recall` to find and read what left the window. `/penpi doctor`
should report `compaction.enabled is false: yes`. See [CONTEXT_ENGINE.md](CONTEXT_ENGINE.md).

### 7. Graceful degradation
With Penfield unreachable **or slow**, expect startup to skip cleanly within the request
timeout (default 15s, `PENPI_PENFIELD_TIMEOUT_MS`; [ADR 0017](adr/0017-fast-fail-timeouts.md)) —
no hang — with the context engine still working and tool errors surfaced (not a crash). If optional web
search is configured, it should remain independent of the Penfield failure.

### 8. Raw diagnostic mode (`--penpi-raw`)
Ask once normally and once with `--penpi-raw`: "is there a Penfield orientation briefing in
your context? ORIENT-YES or ORIENT-NO." Expect **`ORIENT-YES`** normally and
**`ORIENT-NO`** in raw mode. At byte level, normal mode's system prompt has one `<penpi-memory>`
section with `BEGIN/END PENFIELD PERSISTENT MEMORY` markers; raw mode has none. Confirm raw
mode still connects and retains Penfield tools, transcript search, and the context engine
(with its compaction cancellation) while making no automatic `awaken` or `reflect` call. See
[PROMPT_LAYERS.md](PROMPT_LAYERS.md).
