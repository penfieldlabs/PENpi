# Changelog

All notable changes to **PENpi**. Format: [Keep a Changelog](https://keepachangelog.com/).
PENpi versioning starts at `0.1.0`. (Pi core has its own changelog at
`packages/coding-agent/CHANGELOG.md`.)

## [0.3.0] — 2026-09-03

Hardening against providers whose usage reporting cannot be trusted, plus release
process fixes found while gating this release.

### Fixed
- **A provider's reported total can no longer destroy the context window.** The report
  feeds two different decisions and they are now separated. *Uninterpretable* values —
  non-finite (`NaN`, `Infinity`) and non-positive — are refused outright: they are neither
  learned from nor pruned on, because `Math.max(estimate, NaN)` is `NaN`, which makes the
  eviction budget `NaN` and drops everything evictable from a conversation that was never
  over the ceiling. A value *above the context window* is treated as a credible "this
  request is over the limit" signal but not as a credible measurement: it forces the
  trigger while our own candidate-list estimate remains the budget authority. So an
  over-limit session with real content still prunes to the floor, while six short messages
  paired with an absurd `999999999` are left intact — previously five of the six were
  dropped, and a report of `1100` did the same damage as one of `999999999`.
- **Calibration anchors** additionally reject over-window totals, which would otherwise
  teach a permanent overhead the window cannot hold.
- **Two production advisories**, caught by the gate at release time: `fast-uri`
  3.1.5 → 3.1.7 (high — host confusion and SSRF via URI normalization) and `qs`
  6.15.3 → 6.16.0 (moderate — array-limit bypass, DoS). Both arrive transitively
  through `@modelcontextprotocol/sdk`; both are in-range and lockfile-only, with no
  manifest change.
- **The documented `mcpLifecycle` default contradicted the code.** The lifecycle change
  below updated the source comments, the changelog and every assertion, but not the
  extension README's settings table — which went on listing `eager` as the default and
  recommending it, i.e. recommending the exact warm-profile 401 race the change removes.
  Operator-facing guidance was the one surface nothing checked. The row is corrected, and
  a test now reads it and asserts the documented default equals the value
  `ensurePenfieldMcpEntry` actually writes, so the two cannot drift apart silently again.
- **The repository's own release instructions described upstream Pi's process.**
  `AGENTS.pi.md` told a reader to run `npm run release:*` and rely on a tag-triggered
  workflow with npm trusted publishing. In PENpi that script bumps the version a second
  time, commits `Release vX.Y.Z` and pushes straight to `main` — no PR, no CI — and there
  is no `publish-npm` job, because PENpi publishes nothing to npm. The section now leads
  with PENpi's actual sequence and marks the retained upstream text as Pi's.
  `scripts/create-source-archive.sh` and `scripts/build-binaries.sh` are likewise upstream
  helpers that package `packages/coding-agent` and validate against Pi's version, so they
  can never match a PENpi version; they now say so and point at the right command instead
  of failing with a bare version mismatch.
- **The release workflow could not publish correct notes.** It called
  `release-notes.mjs` with Pi's defaults, so it read `packages/coding-agent/CHANGELOG.md`
  and emitted a bare `Release <version>` placeholder — silently, with exit 0. Fixed by
  passing PENpi's changelog, repo and base path, *and* by fixing the heading matcher,
  which required an ASCII hyphen while PENpi's dates use an em dash. A new `--strict`
  mode now exits nonzero rather than emitting the placeholder, and the workflow uses it.

### Added
- **Continuous-fire warning.** Three consecutive FIFO triggers raise one `ctx.ui.notify`
  per session: the window is permanently full, so unprotected history is aging out and
  durable facts belong in Penfield (Tier 2). A trigger on an *unchanged* candidate list
  does not count — a provider retry re-issues the same conversation, and counting it would
  claim history is being lost when nothing new arrived. Reset on any no-op. Deliberately
  not `console.error`: 0.2.0 moved routine FIFO logging behind `PENPI_DEBUG=1` because
  unconditional writes interleave with the TUI frame.
- **`scripts/make-review-archive.sh`** builds review and release archives from `git archive`
  — tracked files only. The previous `zip -r . -x <denylist>` approach shipped 423 `.git`
  entries and two ignored 391 KB session HTML exports, because a denylist only excludes what
  you remember to name. Refuses a dirty tree, asserts against a forbidden-content list, and
  embeds an `ARCHIVE_MANIFEST.json` recording the commit, since `git archive` correctly omits
  `.git` and a recipient would otherwise have no way to identify the source.
- **Clean-profile component tests** for the MCP ordering: an empty
  `PI_CODING_AGENT_DIR` with no `mcp.json` and no metadata cache, asserting PENpi writes a
  lazy Penfield entry and publishes the bearer token during `session_start`, and that
  first-time login writes the entry and reloads exactly once without orienting first. These
  drive a fake Pi host, so they assert PENpi's half of the contract cheaply.
- **Cross-package integration test** for the other half: `mcp-integration.test.ts` loads PENpi
  and the real `pi-mcp-adapter@2.12.1` — in that order — through Pi's real `loadExtensions()`,
  drives them with Pi's real `ExtensionRunner`, and points them at a real MCP server built on
  the SDK's own server transport. The profile is genuinely empty: no `mcp.json`, no metadata
  cache. Nothing is pre-written. The test asserts the adapter has only its `mcp` proxy before
  `session_start`; that PENpi's own `session_start` then generates the `penfield` entry
  (`lifecycle: "lazy"`, `directTools: true`, `idleTimeout: 5`) and publishes its Penfield
  token; that the adapter re-reads that entry, connects with *that same token*, and
  hot-registers `penfield_recall` and `penfield_store`; that both are **active** in the bound
  tool registry, not merely registered; and that all of it holds before the first
  `before_provider_request` — no restart, no settings edit.
  A second test covers the **warm** path, which the clean one structurally cannot see: it
  runs a full session to let PENpi and the adapter produce a real `mcp.json` and metadata
  cache, then starts a second session with `PENFIELD_JWT` unset, as a fresh process would.
  It asserts nothing contacts Penfield before `session_start` publishes the token, that the
  tools then become active, and that invoking `penfield_recall` succeeds carrying the right
  bearer with no 401 anywhere in either run. Reverting the default to `eager` fails it with
  ten requests before `session_start` — the race itself, observed.
  It also pins a non-obvious consequence: `computeServerHash()` hashes the *resolved* bearer,
  so before the JWT is published the adapter's own metadata cache fails validation too. The
  warm path cannot be served from cache early; the fix is to not act before `session_start`.
  Two things are simulated, both at the edges: the Penfield deployment (the fixture, reached
  by redirecting that origin's socket at undici's dispatcher, so the URL entry PENpi writes is
  used verbatim) and the credential (a seeded unexpired token store, with no refresh token, so
  a broken cache path fails the test instead of reaching the real auth server).
  The fixture *enforces* that bearer — a wrong one gets a 401 and reaches no tool — so the
  direct tools existing is itself evidence the adapter authenticated with the token PENpi
  published. Recording the headers would not show that: PENpi's own MCP client uses the same
  token, so "the right bearer appeared" is satisfiable by PENpi's traffic alone. The
  enforcement is pinned by its own test, because inside the main flow the 401 path is
  unreachable — earlier assertions catch any mutation that would produce one.
  Verified non-vacuous by mutation: reversing the load order, suppressing activation of
  hot-registered tools, pre-writing `mcp.json`, flipping `directTools` to `false`, and
  restoring the `eager` default each fail it, at five different assertions.
  The suite drives Pi's *compiled* loader, so it requires a built monorepo. That prerequisite
  now fails with a message naming the missing path and the command to fix it, rather than
  reading as a PENpi regression — running vitest against an unbuilt checkout, or against a
  deployed copy of the extension alone, is a prerequisite violation.
  Pi's loader is what makes this possible: it aliases the `@earendil-works/pi-ai` root to the
  `compat` entrypoint, which is where `complete` lives. A harness that bypasses the loader
  fails at module load, and that failure says nothing about the adapter.
- **`scripts/make-review-archive.test.mjs`** covers the helper end to end in a throwaway
  repository: a relative output path (the form the release workflow uses), an absolute one,
  cross-ref provenance, dirty-tree refusal, and forbidden-content rejection. Both defects the
  tests were written for were verified to fail them before the fix. The suite includes an
  annotated-tag case, because `git rev-parse <annotated-tag>` returns the tag object's sha
  rather than the commit's — git peels it transparently for `archive` and `show`, so the
  archive contents were correct while the manifest recorded a sha that was not a commit.
  That is the ref form the release workflow passes, and no HEAD-based test could reach it.
- **`check:lockfile-versions`** in the gate: a full version sweep across the root and
  extension manifests, the lockfile's three version entries, the MCP handshake literal, and
  the presence of a CHANGELOG section. Editing a version by hand leaves the lockfile behind —
  npm only rewrites it during an install — so the tree stays clean and the gate passes while
  the release ships manifests that disagree.
- **`scripts/check-release-assets.mjs`**: an interlock asserting a built archive contains the
  extension and identifies as PENpi before anything is published.
- **Release / review archive documentation** in `docs/TEST_PROTOCOL.md`: one canonical
  command, what the archive is guaranteed to exclude, and how a recipient verifies one
  (`ARCHIVE_MANIFEST.json` for provenance, `SHA256SUMS` for integrity). `npm audit
  signatures --omit=dev` is now part of the documented gate alongside the other checks.

### Changed
- **Penfield's direct tools are available on the first message of a clean install.**
  Three things had to change together. The adapter pin moves `2.10.0` → `2.12.1`: 2.12.0
  added runtime hot-registration of newly discovered direct tools, and before it the
  adapter registered them only from a pre-existing metadata cache, so a clean install's
  own bootstrap says tools arrive *after a restart*. PENpi's `mcp.json` entry keeps the
  adapter's `lifecycle: "lazy"`, which is the only value that works on **both** startup
  paths. `eager` is the intuitive choice and is wrong: PENpi publishes `PENFIELD_JWT` from
  `wireConsciousLayer()` during its `session_start`, but on a warm profile the previous
  session's `mcp.json` is already on disk, so an eager entry makes the adapter connect
  during extension *loading* — before any `session_start` handler exists. That connection
  takes a 401, the adapter throws `UnauthorizedError` without retrying, and the direct
  tools are gone for the whole session. Ordering inside `wireConsciousLayer()` cannot help;
  the adapter is past that point before PENpi runs. Under `lazy` nothing is contacted at
  load, and the adapter's `session_start` — which runs after PENpi's — has both the config
  and the token. (Automatic orientation is unaffected either way — it uses PENpi's own
  `PenfieldClient`, not adapter tools.) And
  `/penpi login` now writes the Penfield entry and calls `ctx.reload()` rather than
  orienting inline: on a first unauthenticated launch the adapter has already initialised
  with no Penfield server to register from, so orienting there changes nothing. The
  reload's `session_start` orients exactly once. Explicit `lifecycle` overrides are
  unaffected. Not upgrading to the current 2.29.0, which peers on `@earendil-works/pi-ai
  ^0.84.1` while PENpi remains on Pi 0.83.0.
- **`idleTimeout` was off by 60x.** The adapter documents it in *minutes*; PENpi wrote
  `300` intending five minutes, so an idle connection was held for five hours. Now
  `DEFAULT_IDLE_TIMEOUT_MINUTES = 5`, with the option documentation corrected.
- **Releases ship source, not binaries.** The inherited binary builder packages
  `packages/coding-agent` and has never copied `.pi/extensions/penpi`, so every attached
  asset was upstream Pi — the published v0.2.0 archive identifies itself as
  `@earendil-works/pi-coding-agent` `0.83.0` with no PENpi in it. PENpi is installed from
  source anyway (`scripts/penpi-global.sh` symlinks a clone), so the release now attaches a
  verified source archive and `SHA256SUMS`. `scripts/build-binaries.sh` remains as an
  upstream Pi helper and is documented as such.
- `BRIEFING_CUSTOM_TYPE` moved from `index.ts` to `config.ts` so the constant has one home.
- `npm audit signatures --omit=dev` added to the documented release gate.

### Not shipped — and why
An `instructionsFile` option was built and withdrawn before release, along with the pinned
message infrastructure that supported it. It reconstructs the pattern PENpi exists to
replace: a flat file on disk, read at startup and injected into context, is `CLAUDE.md`
under another name.

The defect that motivated it is real — standing instructions typed as ordinary `user`
messages are evicted oldest-first once a session crosses the ceiling, and the agent then
looks disobedient rather than broken. The fix is to configure them in Penfield so they
arrive through `awaken()` inside the orientation briefing, which `isProtected()` already
shields. That is a deployment action, not a code change.

## [0.2.0] — 2026-08-19

External code-review fixes (context-management correctness + injection hardening),
plus a second review round on the fixes themselves. Versioned 0.2.0 rather than
0.1.1 because F2 amends a headline guarantee: "PENpi never summarizes" becomes
"never, except genuine single-unit overflow that FIFO cannot resolve" (ADR 0023).

**Upstream base: Pi `0.83.0` (`845d6ff1f6643aba440341cce877ce1c43ebbc39`, published
2026-07-29)** — the same base as 0.1.0, and the revision this release was audited
against. It is deliberately *not* the latest Pi: `0.84.2` shipped 2026-08-14, and the
`0.83.0...0.84.2` delta is 508 commits over 674 files, touching 35 files PENpi has also
modified. That upgrade is scheduled as its own independently gated release rather than
folded into an already-reviewed candidate. It is not a version-only change: Pi 0.84
broadens automatic overflow recovery to cover responses that stop at a recoverable
output-length limit and reports it under the same `overflow` reason PENpi allows, so it
alters the semantics ADR 0023 documents and needs its own review and tests.

### Added (second review round)
- **Sliding low anchor:** the calibration regression re-anchors — once the anchor
  pair spans ≥64 estimate tokens, an accepted sample promotes the old high to the
  new low, so the slope is always the most recent well-separated secant. An
  atypical first sample (taken before tool definitions loaded) no longer skews
  calibration for the whole session.
- **Window-change reset:** a context-window change resets calibration anchors —
  it signals a model switch, and calibration is tokenizer- and system-prompt-
  specific. Residual known limitation: a same-window model swap keeps stale
  calibration (bounded by the floor-aware cap, conservative direction) until the
  session ends.
- **State-entry fidelity:** the session state entry now stores the RAW Penfield
  briefing/reflection (Tier-3 search returns what Penfield actually holds); when
  sanitization changed anything, the injected variant is stored alongside so an
  audit sees exactly what the model received. (A per-session nonce fence was
  considered and rejected: an LLM is a perceptual reader, not a parser — a forged
  fence with the wrong nonce still looks like a fence; removing the pattern beats
  labelling it.)
- **Kept-token bound restored:** the tiny-window unit test re-asserts a concrete
  bound (floor + notice allowance), and the property suite adds P6: for every
  triggered plan, `keptMessageTokens ≤ max(floor·window, liveUnit) + 64`.

### Fixed
- **FIFO leading-role repair (F1):** a pruned window could begin with an `assistant`
  message (the suffix walk keeps whole assistant+toolResult units), which Anthropic's
  Messages API validation rejects with HTTP 400 — reachable in ~17% of triggering
  windows on the suite's own fixture. (Live-checked Aug 2026: OpenAI-compatible APIs
  tolerate assistant-led lists and Gemini's current API accepts model-led contents;
  the repair keeps the window valid for the strictest target provider.) A triggered plan now guarantees a user-convertible first
  message, prepending a small call-scoped `penpi-fifo-notice` custom message when
  needed (never persisted to the session).
- **Overflow recovery restored (F2, [ADR 0023]):** disabling compaction had also
  disabled pi's context-overflow recovery, so a single oversized atomic unit
  hard-failed the turn. `compaction.enabled` now gates only routine threshold
  compaction; the `session_before_compact` hook is reason-aware (cancel `threshold`,
  allow `overflow` and `manual`, cancel when the reason is absent).
- **Learned-overhead ratchet (F3), generalized to two-point calibration:** the
  trigger state now keeps two full-coverage report anchors and derives
  `reported ≈ slope × estimate + offset` by regression — the chars/4 heuristic's
  undercount on CJK/base64/minified content (up to ~4x) scales with the messages
  and cannot be modelled as offset overhead. Stale post-prune reports are rejected
  by a monotone-growth rule, the offset's use-time cap is floor-aware
  (`min(0.5, floor × 0.8) × window`), state stores raw anchors (a small-context
  model visit no longer destroys learning), and `planFifo` attributes over-cap
  overhead to calibration when budgeting. Net effect: no zeroed budgets
  (single-turn amnesia), no estimate-path blindness after pruning starts, and
  randomized 80-turn hostile-estimator simulations stay under the real window.
- **Degenerate FIFO tests:** the tool-pairing sweep and two sibling tests passed
  `currentTokens=99999`, zeroing the budget at every window and testing one scenario
  58 times. Re-parameterized with realistic totals; the sweep now asserts it
  exercises multiple boundaries, plus the F1 leading-role invariant.
- `keptMessageTokens` is now consistently `0` on non-triggered plans.

### Security
- **Memory delimiter forgery neutralized ([ADR 0024]):** briefing/reflection text from Penfield is
  sanitized before injection — runs of `=` become `≡` — so stored memory content can no
  longer fabricate the `=== END PENFIELD PERSISTENT MEMORY ===` fence and smuggle itself
  outside the trust wrapper. Three passes are needed, because a forged fence arrives in
  more than one shape: line-leading on real newlines; behind a JSON-escaped newline
  (`reflect()` returns a JSON blob, so a stored memory's newlines reach us as the two
  characters `\` + `n` and *nothing* is ever at a line start — a line-anchored rule alone
  matches nothing and the fence passes through verbatim, verified live against a dev
  Penfield instance); and mid-line. The last two passes are scoped to the wrapper's own
  marker words, since a blanket rule would rewrite every `===` in stored JavaScript.
  Runs are replaced character-for-character, so offsets into the text still hold.
  The session state entry keeps the RAW text, with the injected variant stored alongside
  when sanitization changed anything (see State-entry fidelity above).
- **Dependency advisories cleared — `npm audit` is clean, production and dev.**
  `undici` 8.5.0 → **8.10.0**: 8.5.0 sat in the range affected by the response
  desynchronization advisory (`>=8.0.0 <8.9.0`), and `undici` is the HTTP client behind
  every provider and Penfield call, so a retried request could be served another
  request's response. Three transitive advisories cleared alongside it:
  `hono` 4.12.33 → **4.12.34** (four advisories: CORS ReDoS, `memo()` cross-user data
  disclosure, Proxy Helper `Connection` header leakage, Language Middleware DoS), reached
  via `@modelcontextprotocol/sdk`; `undici` 6.27.0 → **6.28.0** nested inside
  `@earendil-works/gondolin`; and `nanoid` 3.3.16 → **3.3.18** (high, dev-only, via
  `vitest → vite → postcss`). `npm audit` and `npm audit --omit=dev` both now report
  **0 vulnerabilities**, and registry signatures verify.

  Pins are recorded as `overrides` in the root `package.json` *and* materialized in
  `package-lock.json`, because this workspace cannot currently regenerate its lockfile
  from scratch — npm 10.x aborts with `Cannot read properties of null (reading
  'edgesOut')`. That failure predates this release and is independent of these pins;
  `npm ci` is unaffected and is what CI and the documented gate use.

### Documentation
- **README no longer overstates the guarantee.** It claimed detail is "never summarized
  away" and "nothing important is lost", which 0.2.0 deliberately no longer promises:
  overflow recovery may summarize a single atomic unit FIFO cannot shrink. The headline,
  the "Why" section, and the hook table now state the bounded exception and link
  [ADR 0023]. `.pi/extensions/penpi/README.md` had the same drift on
  `session_before_compact` ("returns `{ cancel: true }`") and now documents the
  reason-aware behaviour.
- **PENpi reported the wrong version to Penfield.** The MCP client handshake in
  `penfield-client.ts` hardcoded `version: "0.1.0"`, so a 0.2.0 client would have
  introduced itself to the server as 0.1.0. Replaced with a `PENPI_VERSION` constant that
  a test asserts against the extension's `package.json`, so the literal cannot drift
  past a release again.
- **The injected protocol no longer overpromises.** `PENPI_PROTOCOL` told the *model*
  "Nothing is lost (transcript + Penfield)" on every oriented session — the same absolute
  guarantee 0.2.0 amends, in the one place it is a live behavioural contract rather than
  prose. It now describes routine roll-off as recoverable and names the overflow exception.
  Two tests pin the wording so it cannot drift back.
- **Stale maintainer-facing docs corrected.** The `index.ts` module header still said
  `session_before_compact → always cancel`, contradicting the reason-aware implementation
  in the same file. `docs/ARCHITECTURE.md` still claimed "Nothing is summarized away" and
  documented the hook as an unconditional `{cancel:true}`; both are corrected in place,
  since it describes current architecture. ADR 0003 and ADR 0004 keep their historical text
  and gain amendment blocks pointing at [ADR 0023] — by cross-reference rather than rewrite,
  since accepted ADRs are immutable and 0023 already carries the superseding decision.
- **Gondolin engine warning documented as expected.** `npm ci` emits one EBADENGINE
  warning: the upstream Pi example extension `@earendil-works/gondolin@0.12.0` wants Node
  >=23.6.0 while the repo supports >=22.19.0. The documented source install includes
  Gondolin as an upstream example workspace, which causes the expected Node-engine
  warning. PENpi and Pi core do not import or load it during normal execution, and
  coding-agent's runtime shrinkwrap/install-lock exclude it. Left in place to avoid adding
  divergence ahead of the Pi 0.84.2 integration; see `docs/TEST_PROTOCOL.md`.
- **Release gate is reproducible from a clean checkout.** `docs/TEST_PROTOCOL.md` and the
  README development section omitted `npm run build`, without which `check:penpi` and
  `npm test -w penpi` fail on a fresh tree (`@earendil-works/pi-coding-agent` resolves
  through `packages/coding-agent/dist`). Both now document the full sequence — install,
  build, check, test, audit — and separate it from the developer edit-test loop.

### Changed
- Routine FIFO prune logging and the session_start banner are now gated behind
  `PENPI_DEBUG=1` (unconditional `console.error` interleaved with the TUI frame).
- **`npm audit` workflow runs weekly instead of daily**, and gains a dev-advisory step
  gated at `high`. The job catches advisory drift against pinned versions, which moves on
  a weekly cadence; running daily re-reported an identical finding for 12 consecutive days
  before this release.
- The two FIFO property tests declare an explicit 30s timeout. The 4,000-seed property
  could exceed Vitest's 5s default on a cold or contended runner.

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
