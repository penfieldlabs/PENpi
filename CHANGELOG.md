# Changelog

All notable changes to **PENpi**. Format: [Keep a Changelog](https://keepachangelog.com/).
PENpi versioning starts at `0.1.0`. (Pi core has its own changelog at
`packages/coding-agent/CHANGELOG.md`.)

## [Unreleased]

## [0.7.0] — 2026-11-08

### Changed
- **PENpi is on upstream Pi v1.5.0** (from v1.4.0). See Pi's own changelog
  (`packages/coding-agent/CHANGELOG.md`). What PENpi users notice:
  - Pi's default system prompt is shorter and reworded: about 580 characters (125 to 145 tokens)
    less per request, and the edit tool's guidance now asks for one call per file with short,
    unique matches.
  - Tool arguments are checked with Pi's new schema validator, which converts what it can: a
    number or a boolean given as a string, and a single value where a list is expected. This
    applies to MCP tools too, Penfield's included: a model's `"3"` for a limit or one tag for a
    list of tags now reaches Penfield as a number or a list (checked against Penfield). A value
    that cannot be converted is refused before the call, and the message now reads
    `- path: message`.
  - The model catalog comes from models.dev's v2 catalog. PENpi's model data is v1.5.0's own,
    generated with its generator: 100 models added (such as GPT-6.1 Terra), 71 removed (among
    them realtime, image and classifier models), 496 changed. GLM-5.3 Flash and DeepSeek V4.1
    Flash on OpenRouter, DeepSeek's own models, Claude Sonnet 4.5 and Gemini 2.5 Flash are
    unchanged.
  - A session write that fails is rolled back, so later entries never point at an entry that is
    not on disk.
- **Security fixes PENpi gains from v1.5.0:**
  - a saved "Do not trust" decision for a project is kept, also for a project with only an
    `AGENTS.md`;
  - terminal titles and the sign-in, device-code and info URLs in the login dialog are shown
    without control characters, so they cannot inject terminal escapes;
  - OAuth URLs that are not web URLs (for example `search-ms:`) are no longer handed to the
    operating system, including ones from an MCP server's OAuth flow in Pi's own MCP client;
  - ANSI stripping removes private-prefix sequences from tool and `!` output;
  - `pi.exec` bounds its output, sends its SIGKILL fallback, and keeps split UTF-8 intact;
  - a stored OAuth token is no longer sent as an explicit API key in summaries of SDK sessions;
  - the `pi-ai` command-line tool writes its auth file with mode 0600;
  - managed package installs skip npm's audit advice, which could install a second Pi;
  - managed package installs from a symlinked agent directory no longer write nested lock
    entries;
  - a `contentIndex` in a streamed message is checked, so a `__proto__` key or a huge index
    cannot corrupt the message;
  - on macOS, aborting a shell command no longer lets the next command in a list run.
  PENpi keeps its own changes on top (exact pins for managed installs, hidden extension flags,
  the held proxy CONNECT, compaction off, no update banner, every continuation printed in
  `pi -p`, credentials kept out of shell commands); upstream fixed none of them.
- **Fewer dependencies:** upstream dropped `shx`, `autoevals` and the sandbox example (with
  `@anthropic-ai/sandbox-runtime`), so PENpi's pins for them are gone; the vitest, undici and
  minimatch updates PENpi carried are now upstream's own.

### Fixed
- **CI's check of the engine on stock upstream Pi finds its base again.** 0.6.0's squash left no
  upstream history on `main`, so the job could not fetch the upstream base. The release branch
  records the upstream merges again, and the base is tagged on GitHub.

### Known issues
- **E2: two runs detect silent truncation one call late** (C6, lag 4 against the limit 3). Both are
  accepted until 0.8.0, measured on the upstream v1.5.0 corpus:
  - data.o200k.1m.silent-messages, accepted since 0.6.0;
  - research.glm.32k.silent-messages, new: Pi 1.5.0's shorter system prompt keeps one call just
    over the test server's limit (on Pi 1.4.0 the run passes at lag 3).

  Every other run passes, with no false detections.
- **After a cut, an agent can pick up an earlier task that is already finished, or report it as
  done**, as in 0.6.x.

### Release gate
- **GLM gate: REPEAT RUN (reference drift), not rerun. DeepSeek report run: PASS.** 0.7.0 ships
  on the evidence, without a gate pass. On the same GLM night it matched 0.6.1: facts 293 against
  290 of 300, and t1 rules 27 against 27 of 30. The figures are in PR #44.

## [0.6.1] — 2026-11-06

### Fixed
- **Penfield login across several PENpi processes.** Penfield issues a new refresh token on every
  refresh and refuses one that was already used. Each PENpi process kept the refresh token it had
  read, so when several sessions refreshed at once, or one refreshed after another already had,
  all but one were told to run `/penpi login`. A process now reads the token store again before
  it refreshes and uses a token another process already stored. Refreshing and saving happen
  under a lock file beside the token store (`penfield-tokens-<env>.json.lock`, mode 600), which
  is taken over after 70 seconds (four times the Penfield request timeout plus 10 seconds) if the
  process holding it died. Anything else at the lock's path (a directory, a symbolic link) or a
  stale lock that cannot be removed makes PENpi refresh without the lock rather than wait. After
  a refused refresh token, PENpi reads the store once more before asking for a login. After
  upgrading, restart the PENpi sessions still running 0.6.0: they take no lock and do not read
  the store again, so they can still be told to run `/penpi login`, and can write the store back
  after a logout.
- **`context_recall` on a tool call returns its result.** Recalling the entry of a tool call
  (the id `context_search` lists for a hit on a file name) returned only the call, such as
  `read({"path":"ops/freeze-window.yaml"})`, and a model could take that for the whole answer.
  The result now follows the call: in full when it fits the page, otherwise a line naming the
  result's entry to recall. The page keeps its limits: each result is measured in tokens at its
  own density, the pointer lines count too, and when not even a pointer fits, one line says how
  many more results there are.
- **The engine says when it steps aside.** When a request's messages do not match the engine's
  record of the session, the engine sends them uncut and does not manage the window. Another
  extension that adds or removes messages in Pi's `context` event causes this on every request,
  and nothing told the user. The engine now warns once per session (on stderr in print and json
  mode), `/penpi doctor` shows the count, and KNOWN_LIMITATIONS lists the incompatibility. An
  extension that rewrites a message's content and keeps the roles is not detected: the engine
  sends its own copy, so the rewrite is undone without a warning (KNOWN_LIMITATIONS).
- **The installer accepts packages written as objects.** Pi's settings allow a package as a
  string or as an object with a `source` and resource filters; the installer refused the object
  form ("packages must be an array of strings") and stopped. It now accepts both, and removes a
  stock `pi-mcp-adapter` given either way.
- **Engine settings that contradict each other are caught.** Each value in the `penpi` block was
  checked alone, so `lowWater` at or above `highWater`, or `ratioFloor` above `ratioCeiling`,
  was accepted (with `lowWater: 0.9, highWater: 0.5` a session cut 86 times instead of 8). Such
  a pair now falls back to the defaults for both, with a warning. A key PENpi does not know,
  such as a misspelling, is reported with the closest known name.
- **`search_transcript` searches the session folder Pi uses.** It built the folder from the
  working directory, so with `sessionDir` in settings, `--session-dir` or
  `PI_CODING_AGENT_SESSION_DIR` it searched a folder with no sessions. It now asks Pi for the
  session's folder. A custom folder holds every project's sessions, so there it reads only the
  sessions whose header names this project's folder, as Pi's own session list does.
- **Stdio MCP servers no longer get the Penfield credentials.** PENpi keeps the Penfield bearer
  in its environment as `PENFIELD_JWT` for the MCP adapter, and the adapter starts a stdio
  server with that whole environment, so every stdio server in the global `mcp.json` received
  the bearer (and an API key in `PENPI_PENFIELD_API_KEY`). PENpi now gives each stdio server
  both empty; a server whose own `env` names one keeps what it names. Pi's shell already
  stripped both from the commands the agent runs.
- **An expired login code is named as such.** When the device login's code expired before it
  was approved, `/penpi login` reported "device-code polling failed: invalid_grant" (Penfield's
  answer for an expired code). It now says the code expired and to run `/penpi login` again.
- **A `penpi` block in a project's settings is reported once.** The warning that it is ignored
  printed several times per start (six in one review); it now prints once.
- **The docs say what they should.** KNOWN_LIMITATIONS no longer says the token store is written
  in place (it is written to a temporary file and renamed); AGENTS.md says what the commit hook
  runs (`npm run check` and the lockfile check, not `npm test`).

### Changed
- **`/penpi logout`** revokes the login at Penfield (the refresh token, then the access token, at
  the revocation endpoint Penfield advertises), removes the stored Penfield login (access and
  refresh token) and clears `PENFIELD_JWT` for the session. The local logout happens whether or
  not the revocation worked. Logout may first wait for another session's refresh to finish (the
  refresh lock: up to 80 seconds by default), then gives the revocation at most 20 seconds. The
  message says whether the login was revoked, Penfield refused (an HTTP error), Penfield could
  not be reached, or the revocation endpoint Penfield advertises is not on an address PENpi
  trusts (it is then not used; refresh and login are not affected). Penfield ends the refresh
  token; an access token already handed out keeps working until it expires (up to 24 hours), and
  the message says so. Logout takes the refresh lock first, so a refresh running in another
  session finishes before the store goes, and no PENpi 0.6.1 session writes the store back
  afterwards. Your other PENpi sessions find the store gone at their next request and ask for
  `/penpi login` instead of refreshing. A Penfield connection the MCP tools already have open
  keeps working until it reconnects, its session ends or its access token expires (up to 24
  hours), and the message says so. After logging in as a different account, restart the PENpi
  sessions that were running: a session that was idle through the logout and the new login finds
  a store again and keeps the old account's access token (up to 24 hours), so its memory goes to
  the old account. Uninstalling PENpi leaves the login in place, so a reinstall keeps it, and its
  output now says where the token store is and that `/penpi logout` removes it.
- **The embedded MCP adapter subscribes to nothing on Pi's event bus.** 0.6.0 blocked the four
  request channels pi-mcp-adapter 7.0.0 listens on; 0.6.1 blocks every subscription, so a
  channel a later adapter release adds cannot answer other extensions unnoticed. The adapter
  still emits its status and tool-approval events. `/mcp`, Penfield's tools and the adapter's
  status work as before.

## [0.6.0] — 2026-11-05

### Changed
- **PENpi is on upstream Pi v1.4.0** (from v1.1.0). See Pi's own changelog
  (`packages/coding-agent/CHANGELOG.md`). What PENpi users notice:
  - When the final answer is still cut off at the output limit after the engine's continuations,
    `pi -p` exits 1, as in 0.5.x, and the stderr message is now Pi's own ("Response was truncated:
    the model reached its output token limit."). `--mode json` exits 0 in that case.
  - The `kimi-coding` provider uses Chat Completions.
  - Pi retries more transient provider errors before a run ends, and sends client identity
    headers with each request.
  - Upstream removed the experimental server stack and its client, protocol and server packages.
- **The model data is v1.4.0's own**, as published in `@earendil-works/pi-ai` 1.4.0, with no
  changes. Context windows, output limits and prices change for many models, and the engine plans
  against them. Claude Sonnet 5.5's cache reads cost $0.10 per million tokens, as Anthropic lists
  them now; 0.5.x corrected them to $0.20, which is no longer the published price.
- **The engine's estimate follows Pi 1.4.0's converters.** Thinking from another model is no longer
  sent (Pi 1.1.0 sent it as text), so the estimate drops it too. An error tool result with images
  is sent to Anthropic, and to Claude on Bedrock, with a placeholder per run of images and a
  caption; the estimate counts both.
- **The embedded MCP adapter is pi-mcp-adapter 7.0.0** (from 2.12.1), on the MCP client 2.3.1.
  Penfield's tools keep their names and stay direct. What changes:
  - Pi 1.4.0's own MCP support stays off, as before: PENpi keeps `/mcp` with the adapter, so a
    trusted project's `.pi/mcp.json` still adds no servers (ADR 0026). If the adapter fails to
    load, PENpi registers a `/mcp` of its own that says what failed, so this still holds.
  - Other extensions cannot add MCP servers or reach Penfield through the adapter. A server one
    registers with `pi.registerMcpServer()` is reported and not connected. The adapter's own
    requests on Pi's event bus (register a server, call an MCP tool, open a raw MCP session) get
    no answer.
  - No MCP server learns local paths: `roots`, which 7.x answers with the working directory, is
    off for every server. MCP Tasks are off too, since a task's result would arrive after its
    call, as a message the context engine has not planned for. A server in the global `mcp.json`
    may turn either on, except Penfield.
  - The adapter gets PENpi's defaults for its settings: no `install` or `save-script` actions, no
    semantic tool search (a model call outside the engine's accounting), and no sampling. The
    global `mcp.json`'s own `settings` still override them. Elicitation (a server asking the
    user a question) is the adapter's default: on with a UI, off without one.
  - The `mcp` tool's description and parameters are longer, so every request's tool list grows a
    little, and a session's cached prompt prefix changes once.
  - The adapter pins `recheck` 4.6.0-beta.3, a pre-release, exactly. PENpi installs the stable
    4.6.2 instead (shipped 26 October), through an npm `overrides` entry; the adapter uses it to
    check a regular-expression tool search before running it.

### Fixed
- **No 401 from Penfield at startup with `penpi.mcpLifecycle: "eager"`.** An eager (or
  `keep-alive`) Penfield entry made the adapter connect while extensions load, before PENpi had
  published the login, so the first connect was refused and stderr showed "MCP: Failed to connect
  to penfield". The adapter connected again at the session's start, so the tools worked. PENpi now
  publishes the login before the adapter loads, refreshing an expired one first. With no login,
  the entry is `lazy` for that session, so nothing connects without one.
- **A model request no longer waits behind a held proxy connection.** Behind an HTTPS proxy, Pi
  sent every connection to the proxy through one client, one at a time, so a connection the proxy
  held open (seen with a Penfield connection) held up the model's requests until it closed: 127
  seconds in one test. Each connection now gets its own.
- **One Penfield outage gives one warning.** When orientation failed at start, the first failed
  refresh while healing warned a second time. Those refreshes now only log; a refresh failure
  after a healed orientation still warns, once.
- **A rebuilt window sends the same system prompt as the session did** (D23). After a resume or
  `/reload`, the system messages could be laid out differently from the in-session window, which
  changed the bytes and missed the provider's prompt cache. At every cut, the system messages in
  the kept window that are older than the cut are now merged into the leading prompt, with or
  without a section change: the merged prompt is the same, but a provider that shows system
  messages mid-conversation sees those updates in the leading prompt. A session cut under 0.5.x
  whose kept window holds such a message gets the new layout at its first rebuild under 0.6.0,
  with one prompt-cache miss, once.
- **The replayed-reasoning check is more careful** (D22). It skips a request that appends an
  image (the provider counts the image, the estimate of the appended text does not), counts the
  pre-cut notice, and no longer reports "ignored" while some requests read around 0.4.
- **Copilot's HTTP 413 does not shrink the window.** Pi 1.4.0 counts every HTTP 413 as a context
  overflow, including GitHub Copilot's "failed to parse request", a request too large in bytes
  with no token numbers. The engine leaves that one to Pi, as 0.5.x did, instead of learning a
  smaller window from it. The 413s that Pi 1.1.0 already counted as overflows, Anthropic's
  `request_too_large` and Cerebras' 413 with no body, still recover as overflows, as in 0.5.x, and
  so does a 413 that names a token overflow.
- **A run started by an extension's message** (`sendMessage` with `triggerTurn`) is not recorded as
  the user's request.
- **The silent-truncation check counts the pre-cut notice of the request it judges.** It left it
  out, so the request that carried the notice read about 100 tokens short of its real growth, which
  could hide a small truncation or leave the sample unjudged. It matters only with the notice on.

### Known issues
- **E2 has one known failure, new with the upstream v1.4.0 corpus:** data.o200k.1m.silent-messages
  (C6 detection lag 4 against the limit 3), accepted until 0.7.0. Its first truncations are too
  small for any usage rule to see. The code is not the cause: on the v1.1.0 corpus, 0.6.0 passes
  this run at lag 2, as 0.5.1 does. The earlier entry, research.glm.32k.silent-messages (accepted
  in 0.5.0 and 0.5.1), passes on the new corpus, and it is gone.
- **After a cut, an agent can pick up an earlier task that is already finished, or report it as
  done**, as in 0.5.1.

## [0.5.2] — 2026-11-02

### Security
- **`minimatch` 11.0.3 replaces 10.2.6** (GHSA-g3hv-75wg-m249, moderate: a crafted glob pattern can
  make matching slow; fixed in 11.0.1, with no 10.x fix). Pi uses it to match package resource
  filters and `--models` patterns, with the plain `minimatch(path, pattern, options)` call, which 11
  keeps as it was. 11 adds one dependency, `@isaacs/nonrecursive-glob-match`, by the same author.
- **`shx` 0.4.0 replaces 0.3.4 in the build tools** (the same advisory, development only): 0.3.4 ran
  on `shelljs` 0.8 and its `glob` 7, which carried `minimatch` 3.1.5; 0.4.0 runs on `shelljs` 0.9.2,
  which uses `fast-glob`. `npm audit` reports no vulnerabilities.

### Fixed
- **A failed orientation heals itself.** When Penfield could not be read at session start (a
  network blip, an error result), the session went without memory until it ended. Now each run
  after it tries the read once, and the briefing it brings takes effect at the context engine's next
  cut, as a login's does, so the system prompt still changes only at a cut. A session with no login
  at all still waits for `/penpi login`.
- **The first failed memory refresh in a session is shown once**, as a warning that points to
  `/penpi doctor`. The engine log is opt-in, and doctor helps only if someone looks.
- **A run that ends while the previous refresh is still reading logs it** as `memory refresh: skipped
  (still running)`, so the doctor line's counts add up.
- **A memory refresh no longer reports a change when only Penfield's scores moved.** Penfield's
  `reflect` re-scores its top memories over time, so the same memories read a few minutes apart
  differed in a score digit, and the refresh logged `changed`. The next cut then replaced the memory
  section for nothing, which cost a prompt-cache miss. The refresh now leaves the scores out of its
  comparison; a memory added, removed or reordered, or a changed briefing, still counts.
- **A manual `/compact` records the window's real size after the cut** in the engine's statistics,
  the number its log line prints (it recorded 0).
- **The notices about the MCP adapter** (its config could not be built, or it did not load) show the
  error as one short line, as PENpi's other notices do since 0.5.1.

## [0.5.1] — 2026-11-01

### Security
- **`zod` 4.6.6 replaces 3.25.76** (GHSA-mrhx-c7xc-m3w5, memory exhaustion when validating
  oversized constrained collections; fixed in 4.6.6, with no 3.x fix). An override gives every
  package zod 4.6.6: pi-mcp-adapter's own schemas, PENpi's Penfield client (MCP SDK 1.x) and
  `@anthropic-ai/sandbox-runtime`, whose range is ^3.24.1 but whose schemas use only what zod 4
  keeps. The sandbox example extension's own lockfile takes the same override, and the example
  declares its config type itself, because sandbox-runtime's type is inferred with zod 3's types
  (types only; the values it passes are unchanged).

### Added
- **`/penpi doctor` shows the memory refresh:** "memory refresh: last <time> <outcome>; N changed,
  N unchanged, N skipped, N failed (last error: ...)".

### Fixed
- **The memory refresh no longer stops for the rest of a session after one failed read.** A failed
  read left the Penfield client disconnected, and every later refresh did nothing, silently. The
  next refresh now reconnects first, once per run.
- **An error result from Penfield's `awaken` or `reflect` is a failed read**, at orientation and in
  the refresh. It was composed into the memory section as if it were memory.
- **Every memory refresh is logged** to the engine log (`PENPI_ENGINE_LOG`), one line each and with
  no memory text: changed, unchanged, skipped (not connected, or not oriented), or failed with the
  error. A failed orientation is logged too, a failed connect included (an expired login, for
  instance), and each run after it logs the refresh as skipped (not oriented).
- **Error text in the engine log, the doctor line and PENpi's notices is one short line**, with
  whitespace collapsed and capped at 200 characters. A transport error can carry a whole HTTP
  response, such as a proxy's multi-line HTML error page.
- **A manual `/compact` is logged as a cut:** `cut #N (manual) at ...`, with the same numbers as
  any other cut.
- **The pre-cut notice no longer fails on a stored tool call whose name is not a string.** The
  engine sent Pi's messages unplanned for that request instead.
- **The ADR references in this changelog are links again**, on GitHub and in the release notes.

### Known issues
- **E2:** the known failure research.glm.32k.silent-messages (C6 detection lag 4 against the
  limit 3) is renewed until 0.6.0. The upstream merge planned for 0.6.0 changes E2's corpus, and
  on the upstream v1.4.0 corpus the run does not fail. The detector is unchanged.
- **After a cut, an agent can pick up an earlier task that is already finished, or report it as
  done.** It has been seen when the pinned request is open-ended, such as "pick a topic", and the
  recent window holds no record of the current subtask. Restating the current task gets the agent
  back on it. Work on this is planned for 0.6.0.
- **`minimatch` 10.2.6 has a moderate advisory** (GHSA-g3hv-75wg-m249: a crafted glob pattern can
  make matching slow). The advisory was published after this release was reviewed, and the fix is
  only in minimatch 11, a major version. Pi uses minimatch to match package resource filters and
  `--models` patterns. 0.5.2 fixes it with minimatch 11.0.3.

## [0.5.0] — 2026-10-27

### Breaking
- **PENpi refuses to run with `compaction.enabled: true` ([ADR 0032]).** The context engine
  replaces compaction and cannot work next to it, so with the setting `true` PENpi shows an error
  and shuts the session down before any model request. PENpi 0.4.1 accepted the setting.
  Migration: remove `compaction.enabled` from your settings, or set it to `false` (the fork's
  default with the setting unset is off).
- **Without the PENpi extension, Pi has neither compaction nor overflow recovery.** Compaction
  stays off by default in the fork, and the 0.4 patch that let Pi recover from an overflow with
  compaction off ([ADR 0023]) is gone: the engine does that recovery now. Run PENpi with its
  extension, or turn compaction on when running the fork without it.

### Changed
- **The context engine replaces FIFO ([ADR 0032]).** The model sees a persistent window that
  is cut above 75% of the input budget, down to 45%, and kept stable between cuts, which keeps
  the provider's prompt cache. A header after each cut says what left the window, and carries
  the user's earlier messages and the model's working notes (`context_notes`). `context_search`
  and `context_recall` find and read what left. Nothing is summarized or deleted. Estimates
  follow what Pi serializes for each API and are calibrated per model. Window and output limits
  are learned from errors, length stops and silent truncation, and `/penpi doctor` shows them.
  Overflow and output-limit stops recover without compaction. See
  [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md). In the PENpi-bench release gate on 2026-10-26,
  measured on RC5, which differs from this release only by the tool-call repair below: on cost,
  the billed cost per filler step was about the same as stock Pi's ($0.0038 against $0.0037), so
  the engine is cost-neutral per step, not a saving. The lower cost per unit ($0.094 against
  $0.138, 0.68 of stock's) comes from stock running 34.0 filler steps to reach its three
  compactions against the engine's 18.8 to its three cuts. The verdict was PASS, no sign of harm,
  under decision v3, with v2 and v1 alike, on 29 of 30 pairs. The release candidate recalled 278
  of 290 facts exactly, followed all rules in 56 of 58 tasks, completed 58 of 58, and made no
  compaction and no summarization request. In that run, five stock sessions' compaction summaries
  replaced those sessions' exact values with wrong ones (none did in the earlier run on
  2026-10-18), so we don't quote a single day's gap against stock. The repair leaves every one of
  the 14,548 bench requests byte-identical.
- **`context_search` finds a tool result by its call's arguments**, such as the path a read
  took or the command a bash call ran, and a hit names the result. In the PENpi-bench release
  gate on 2026-10-26, measured on RC5 (the 0.5.0 code without the tool-call repair), the release
  candidate recalled 115 of 116 file and tool-output facts. An earlier run on a different day, before this change, recalled 104 of 120.
  The result is consistent with the change, not proof of it.
- **Planning is capped at 200,000 tokens (`windowCeiling`).** A model with a larger window, such
  as a 1M-token model, is planned as if it had 200,000; set `windowCeiling` (or `0` for no cap)
  or a per-model `limitOverrides` entry to change it.
- **The requested output is capped** to what the window leaves after the input. A model that
  declares no output limit (or an implausible one) is asked for at most 16,384 tokens.
- **A model with no declared context window is planned at 32,768 tokens** (it was compacted
  every so many runs, [ADR 0025]); a `limitOverrides` entry sets its real window.
- **A manual `/compact` moves the window forward** instead of summarizing, and **`/tree`
  summaries are replaced by a fixed notice**: no LLM summary is ever requested.
- **The length continuation is a hidden message** (0.4 sent it as a user message). After a
  stop that spent the whole output limit on reasoning, the model is asked for the answer
  directly (`reasoningOnlyContinuation`), and the turn goes on instead of ending. In the
  PENpi-bench release gate on 2026-10-26, measured on RC5 (the 0.5.0 code without the tool-call
  repair), the release candidate had 11 such stops: the next response was a tool call 6 times and an answer 4 times.
  After the other one, the provider rate-limited the next three requests, and the turn went on once
  Pi's retry got through. Stock Pi's 11 length stops each ended the step.
- **A new status line** shows the window the engine plans against, the last request against the
  cut threshold, the number of cuts and the calibration ratio.
- `/penpi doctor` and `/penpi reset-limits` report and clear what the engine learned.
- **`replayedReasoning: "ignored"` is for providers that do not count the reasoning Pi
  replays.** Set it only on evidence. On a provider that does count it, requests run up to about
  12% over budget: in the E2 misconfigured runs, 5 of 24 went over the 1.02 x budget limit, the
  largest at 1.12 x budget, all on 32k models, with no rejections. The engine checks the setting
  against the provider's reported usage, warns, and `/penpi doctor` recommends `"counted"`.
- **The orientation briefing is part of the system prompt ([ADR 0032]).** PENpi used to send it
  as a message at session start, which the engine's first cut would remove from view. It is now
  the system prompt's `<penpi-memory>` section. It is byte-stable within a session: PENpi reads
  Penfield again after each run, and a changed briefing reaches the system prompt only at the
  engine's next cut, so the provider's prompt cache holds between cuts. The memory is passed as
  data: fenced, JSON-encoded on one line (with `<`, `>` and `&` escaped, capped at 64,000
  characters per text as encoded), after a line saying it is reference data recalled from
  Penfield, some of it written by other agents or copied from the web, and not instructions.
  `displayBriefing` shows it as a notification. A resumed 0.4 session's briefing messages stay in
  the session but are neither sent nor pinned.
- **The memory section is capped in tokens.** Escaped or CJK memory can be many more tokens than
  its characters suggest, and the engine cannot cut the system prompt, so the section stays within
  20% of the planning window and at most 24,000 tokens. Longer memory is cut, with a note saying
  how much was left out. On a 32k model that is about 6,400 tokens.
- **The memory section shrinks with the window.** After switching to a model with a smaller
  window, or when the engine learns that the provider's window is smaller than declared, the memory
  section is cut to the new cap before the next request, so the first request on the smaller window
  fits. On a model whose window does not change, nothing changes. If even the system prompt does not
  fit the window, PENpi stops before sending the request and says so.
- **Smaller session files.** A refresh records a hash and the length of the memory it read, not the
  text, and a cut records the system prompt sections only when they change. Otherwise a setup
  whose memory changes after most runs would add 100 KB or more to the session file per run.
  `search_transcript` no longer returns these state entries, and neither it nor `context_search`
  returns a resumed 0.4 session's briefing messages, so memory text never comes back as tool output
  outside the fence.
- **`/penpi login` during a session** keeps the system prompt (and the provider's prompt cache)
  until the engine's next cut, where the new memory takes effect.
- **A provider switch behind a router is no longer read as silent truncation.** OpenRouter can
  move a session between upstream providers, which count the same request differently. The
  engine now reads which provider served each response and judges each provider's responses
  against that provider's own, so the session keeps its window and a provider that truncates is
  still detected. The engine log shows each switch. A switch still loses the prompt cache; a provider preference in
  `models.json` keeps a session on one provider. See
  [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md#routers-such-as-openrouter).
- **Exit waits at most 2 seconds for a memory read still running**, then drops it; the read
  writes nothing. The exit checkpoint (`save_context`, when `saveContextOnShutdown` is on) still
  waits for Penfield, up to its request timeout (15 seconds by default,
  `PENPI_PENFIELD_TIMEOUT_MS`), since a saved checkpoint matters more than a fast exit.

### Added
- `PENPI_ENGINE_LOG=<path>`: an opt-in engine log with one telemetry report per request. It
  holds no prompt or message text.
- `.pi/extensions/penpi/engine-only.ts`: the engine without Penfield memory, for benchmarks.
- **Fault injection, a testing tool:** `PENPI_FAULTS` (for example
  `overflow=every:7;length=at:3,9`) turns some successful responses into overflow errors,
  output-limit errors or length stops, to exercise recovery. It is loud at startup and on every
  fault, and `PENPI_PRODUCTION=1` refuses it. It is not a setting: `penpi.faults` and
  `penpi.production` are ignored with a warning. See
  [docs/CONTEXT_ENGINE.md](docs/CONTEXT_ENGINE.md#testing-with-fault-injection).
- `npm run setup:tokenizers`: installs the pinned tokenizers the engine tests count with (needed
  before `npm test`; see [CONTRIBUTING.md](CONTRIBUTING.md)).

### Removed
- FIFO, emergency compaction for models without a context window ([ADR 0025]), the
  `agent_end` length continuation ([ADR 0028]; the engine continues length stops itself) and
  the compaction-disabled recovery gating in `agent-session.ts` ([ADR 0023]; the file is upstream
  again). ADRs 0003, 0023, 0025, 0027 and 0028 are superseded by [ADR 0032].
- The settings `contextFloor`, `contextCeiling` and `emergencyCompactionRuns`, and their
  environment variables. PENpi warns at startup when one is set and names it.

### Fixed
- **D26: after a cut, a model redid requests that were already done.** The header carries the
  user's earlier messages, and one model read them as a list of open work: after cuts it edited a
  finished article again, repeated an old cleanup and started an old discovery run. A single
  sentence of the header said those requests were handled. Now every carried message shows the
  day it was sent, and every one that is not the current request is labelled *earlier request,
  already handled* (its rules still apply; its task is not done again unless the current request
  asks for it). The label stays when a message is shown as a pointer or a range line. A line of
  its own names the current request, whether it is pinned or still in the window, and says to stop
  and report when it is done instead of starting requests from earlier messages. The header still
  changes only at a cut.
- **A resumed session gets the new header at its first request.** The header is stored with each
  cut and replayed until the next one, so a session resumed after an upgrade kept its old header
  for the rest of that window. Each cut now records the header's format, and a session whose
  latest cut has an older one cuts once at its first request (logged as `header format 1 -> 2`).
  Older messages leave the view there, as at any cut, and stay recallable.
- **A provider tool call with no id and no name no longer breaks the session.** It is rare; it
  has been seen with GLM-5.3-Flash through OpenRouter. Pi recorded the call and its "tool not
  found" result with an empty id, and the provider then rejected every later request with a 400.
  The engine now leaves such a call out of each request, with a short note in its place, and drops
  its result. A call that has a name but no id keeps its result, under an id made from the saved
  message. The session file is not changed, and requests without such a call are sent exactly as
  before. 0.4.0 and upstream Pi still have the problem.

### Security
- Dependency updates for advisories published after 0.5.0's first candidates:
  - `undici` 8.10.2 → **8.12.3**, in Pi's exact pin (`packages/coding-agent`) and PENpi's.
    Every provider request goes through undici (Pi installs it as the global `fetch`), so this
    closes a crash a malicious server could cause with excessive content encodings. Upstream
    Pi still pins 8.10.2; the change is listed in `docs/UPSTREAM_PATCHES.txt`.
  - `fast-uri` 3.1.9 (MCP SDK schema validation) and `body-parser` 2.4.0 (not loaded: only the
    SDK's server modules use express).
  - Development only: `vitest` 4.1.12 and `vite` 8.3.5, as upstream Pi did; the root `nanoid`
    override follows to 3.3.20, which vite's `postcss` needs.
  - The gondolin example extension takes gondolin 0.14.0 (as upstream Pi did), which drops
    `node-forge`, and undici 6.29.1.
- **Known, deferred to 0.5.1:** `zod` 3.25.76 (GHSA-mrhx-c7xc-m3w5, memory exhaustion when
  validating oversized collections) has no 3.x fix. It validates data from any MCP server
  configured in the global `mcp.json`: pi-mcp-adapter checks its own result-patch notification
  with a zod 3 schema, and, for servers with UI resources, the visualization envelope of a tool
  result. It also validates Penfield's messages, through PENpi's MCP SDK 1.x client. So only a
  malicious or compromised configured server could exploit it. A repository cannot add servers
  ([ADR 0026]), and nothing on the open network reaches it without a configured server. The
  0.5.1 fix is zod 4 through a scoped override, because `sandbox-runtime` pins zod ^3.

### Known issues
- **With weaker models, an agent can go on with work that is already done, or that was off
  task.** Seen with GLM-5.3-Flash after a long autonomous run. D26 marks earlier requests as
  handled and names the current one, which removes the cue seen in production, but it does not stop
  drift once it has started. The same happens when the model is given the full history, with no
  cut at all.

## [0.4.1] — 2026-10-13

### Fixed
- **A short length stop no longer hides the reply and summarizes with compaction
  disabled ([ADR 0023]).** The 0.4.0 guard move let pi's length recovery run with
  `compaction.enabled` false: a `length` stop below the model's `maxTokens` hid the
  reply and compacted. It now runs only with compaction enabled; otherwise the reply
  stays and length continuation carries on. Context overflow still recovers with
  compaction disabled: an explicit provider error, a completed response whose usage
  exceeds the window, and a zero-output `length` stop whose input fills the window.
- **`pi -p` prints the whole continued answer ([ADR 0028]).** Print mode printed only
  the last part of an answer continued after an output-limit stop. It now prints every
  part of the final answer and nothing from earlier tool steps; if the answer is still
  cut off when the run ends it writes one line to stderr and exits non-zero.
- **Pi's built-in MCP extension is disabled in the settings PENpi writes
  (`"extensions": ["-builtin:mcp"]`).** It reads the global `mcp.json` that holds
  PENpi's `penfield` entry and would have served it if the embedded adapter failed to
  load. This also removes the warning it printed on every launch.
- `scripts/penpi-global.sh` and `scripts/make-review-archive.sh` are executable again;
  the release workflow runs the archive script directly.
- `scripts/release.mjs` reads and bumps PENpi's version (root `package.json`, the
  extension manifest and the MCP handshake) and only PENpi's changelog. It used
  `packages/ai`, which would have produced the upstream version and tag `v1.1.1`.
- Git package dependencies install without `--save-exact` again: pnpm 11 rejects it
  and npm ignores it there. Managed package installs still pin exactly ([ADR 0020]).
- `search_transcript` skips `system` entries.

### Security
- Removed every user-facing recommendation of `pi -a` (README, installer message,
  [ADR 0018]). `-a` trusts every project's `.pi/` directory, so a repository's own
  extensions would run inside PENpi with access to the Penfield token file.
- Agent-spawned shell commands no longer receive `PENPI_PENFIELD_API_KEY` (they already
  did not receive `PENFIELD_JWT`).
- The Penfield token file is written atomically (temp file + rename, mode 0600) and
  never through a symbolic link.
- Penfield OAuth and API-key requests refuse redirects (`redirect: "error"`), and
  discovered OAuth endpoints must be on one of the exact configured Penfield origins
  (auth, API, MCP) instead of any `*.penfield.app` host.
- The sandbox example lockfile takes `shell-quote` 1.12.0 again.

### Changed
- CI runs the release archive script on every PR, checks that every shell script the
  workflows, README or installer invoke is executable (`npm run check:script-modes`,
  also part of `npm run check`), and checks out without persisting credentials.
- The weekly npm audit uses upstream's `scripts/npm-audit.mjs`, which records reviewed
  advisories with their reasons.
- Restored upstream Pi v1.1.0's `scripts/build-binaries.sh`,
  `scripts/create-source-archive.sh` and `packages/coding-agent/README.md` (with a
  PENpi note).
- Removed three upstream files PENpi does not use (PENpi deviations, listed in
  `docs/UPSTREAM_PATCHES.txt`): `.pi/extensions/import-repro.ts`, an upstream dev
  extension that would load in every PENpi session started in this repository, and
  `scripts/publish-model-catalog.mjs` with its test (PENpi publishes no model catalog).
- Audited every file that differs from upstream Pi v1.1.0 ([ADR 0031]). `docs/UPSTREAM_PATCHES.txt`
  records the upstream base and each intentional difference with its reason, and
  `npm run check:upstream-patches` (in `npm run check` and CI) fails when the set of
  differing paths does not match it exactly.
- `README.pi.md` and `AGENTS.pi.md` take upstream's changes since 0.83; PENpi's own docs
  drop stale 0.83-era claims (shrinkwrap, `tsgo`, "four hooks", a planned 0.84.2
  integration); `SECURITY.md` takes upstream's corrections. ADR 0002 now describes the
  LICENSE accurately (Penfield line added, MIT terms and Mario Zechner's notice kept).
- Removed `packages/coding-agent/npm-shrinkwrap.json` and its generator, as upstream did:
  nothing in PENpi uses them (no CI step, script, installer or ADR); the generated
  install lock is what CI enforces.
- The release workflow accepts only a tag on `main`'s first-parent history. Once `main`
  records upstream as merged, `git merge-base --is-ancestor` would also accept an
  upstream commit.

## [0.4.0] — 2026-10-12

### Changed
- **Rebased onto upstream Pi v1.1.0** (from v0.83.0). Notable upstream changes:
  - TypeScript 7.0 with an ES2024 target and lib; Node engine stays `>=22.19.0`.
  - `SessionManager` is canonical for `AgentSession` provider context; assigning
    `session.agent.state.messages` no longer replaces future request history.
  - `finishTurn` replaces `shouldStopAfterTurn`.
  - Extension context reworked.
  - New packages: `durable`, `chord`, `mcp`, `codemode`, `client`, `protocol`, `env`,
    `telemetry`. `packages/storage` was removed upstream.
- Release script no longer regenerates `packages/coding-agent/npm-shrinkwrap.json`; the
  generator (`scripts/generate-coding-agent-shrinkwrap.mjs`) is kept for manual runs.
- Upstream compaction tests adapted to PENpi's routine-compaction-off default ([ADR 0003],
  [ADR 0023]): tests that exercise threshold compaction now enable it explicitly.

### Fixed
- Removed 113 files upstream deleted between v0.83.0 and v1.1.0 that the merge had brought
  back (old agent harness, server Radius runtime, `storage/sqlite-node`, and others), plus
  the tsconfig excludes, `./harness` export, and agent dependencies (`diff`, `ignore`,
  `yaml`) that only existed to support them.
- Restored upstream's `packages/coding-agent/vitest.config.ts`; merge-added `source`
  resolve conditions made PENpi's extension tests fail to load `eventsource-parser`.

## [0.3.2] — 2026-10-11

### Added
- **Length continuation ([ADR 0028]).** A response that stopped at the model's output token
  limit (`stopReason: "length"`) ended the run as if it were finished, often mid-sentence or
  mid-file. PENpi's `agent_end` handler now queues a follow-up asking the model to continue
  exactly where it stopped, as part of the same run, at most 3 times per run; past that it
  stops and says so. A zero-output length stop is left alone: pi treats that as a context
  overflow and recovers it itself.

### Fixed
- **FIFO no longer collapses the window when content is denser than the estimate
  ([ADR 0027]).** With a learned calibration slope above 1 (code, CJK, base64), the prune
  budget charged the full history's growth as fixed overhead, so the budget shrank on
  every call: in a simulated session sessions settled at 14-19% of the window instead of
  at the floor. Every FIFO test reported at slope 1, which hid it. The budget is now
  `floor × window` of estimated message tokens, with nothing learned in it; calibration is
  used only to decide when to prune. New tests run sessions at slopes 1, 1.5, 2 and 3.

- **Configuration values are validated ([ADR 0030]).** An empty environment variable
  (`export PENPI_CONTEXT_CEILING=`) read as 0 and clamped to 0.01, pruning on every call;
  it now counts as unset, for the boolean variables too. A non-numeric setting
  (`"contextCeiling": "abc"`) became `NaN`, and a string where a boolean belongs
  (`"saveContextOnShutdown": "false"`) was truthy; both now fall back to the default. A
  ceiling or floor above 1 (`75` meaning 75%) was clamped to 0.99 and is now rejected.
  Every ignored value is reported by name.

- **The emergency compaction finishes before the run settles ([ADR 0025]).** The
  `agent_settled` handler started `ctx.compact()` and returned, so `prompt()` resolved with
  the compaction still running: print mode could exit mid-compaction and the next prompt
  could start alongside it. The handler now awaits it.

### Changed
- **FIFO defaults are floor 0.2 / ceiling 0.8 (were 0.5 / 0.75).** Without calibration in
  the budget, the gap between floor and ceiling is what absorbs a token undercount; 0.2 /
  0.8 holds a 4x undercount. For ordinary prose a session now settles at about 20% of the
  window plus overhead instead of about 50%; raise `contextFloor` to keep more history.
  A floor above 0.25 — including the old 0.5 default copied into settings — gets a
  warning at startup, since dense content can then overflow the window.

### Security
- **Memory fence sanitization catches disguised fences and runs in linear time
  ([ADR 0029]).** Penfield text is now NFKC-normalized (fullwidth `＝＝＝ ＥＮＤ`), stripped of
  format characters (a fence split by zero-width or bidi characters), matched without
  regard to case, and capped at 64,000 characters per briefing or reflection. The mid-line
  pass was not anchored to the start of a run of `=`, so a long run cost quadratic time — a
  second for 16,000 characters of remote text — and now costs linear time.
- **A repository can no longer add MCP servers ([ADR 0026]).** pi-mcp-adapter, run as a
  stock package, layers the project's `.mcp.json` and `.pi/mcp.json` over the global
  config, so any repository could add MCP servers — including local commands, started at
  load when `lifecycle` is `eager` — or replace existing ones. PENpi now embeds the adapter
  through `createMcpAdapter({ config })` with a config built from the global `mcp.json`
  only, plus its `penfield` entry. The adapter's `/mcp setup`, `/mcp enable` and
  `/mcp disable` commands are unavailable in this mode; edit the global file and `/reload`.
  The stock package is gone from `.pi/settings.json`, `penpi-global.sh install` removes it
  from the global settings, and PENpi warns while pi's settings still list it. An
  integration test puts eager command-running servers in both project files and asserts
  neither command ever runs.
- **PENpi settings are global-only ([ADR 0026]).** The `penpi` block of a project's
  `.pi/settings.json` was merged over the global settings with only credentials and paths
  stripped, so a repository could switch the Penfield environment, turn off orientation,
  force the `eager` adapter lifecycle, or set a context ceiling that prunes every turn. It
  is now ignored, with a warning naming the file.

### Dependencies
- **Dependency advisories.** `fast-uri` 3.1.7 → **3.1.8** clears GHSA-hrr3-gc8f-f4qj
  (high — ReDoS in fast-uri’s IPv6 parser). Six transitive bumps clear nine advisories:
  `shell-quote` 1.10.0 → **1.12.0** (GHSA-pqg4-j6r4-53mv, critical — arbitrary code
  execution), `proxy-addr` 2.0.7 → **2.0.8** (GHSA-jqcg-44mw-7w3h, critical —
  trust-boundary bypass), `@modelcontextprotocol/sdk` → **1.32.1**
  (GHSA-6qxp-vccf-f47h, high), `source-map-js` 1.2.1 → **1.2.2**
  (GHSA-68fv-2mgg-jv7q, high), `brace-expansion` 5.0.9 → **5.0.12**
  (GHSA-qhr7-859c-m2p7 high, GHSA-6j4f-fj2g-mc7p high, GHSA-q2hr-2g5m-vwhr moderate),
  and `smol-toml` 1.8.0 → **1.9.0** (GHSA-r4xh-jqrq-34v2, moderate).
  Override bumps: `hono` 4.12.34 → **4.13.13** clears GHSA-gqvv-2mrq-wpjv,
  GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx and GHSA-hxh3-vqpv-xpqv (moderate —
  XSS, path traversal and DoS); `undici` 6.28.0 → **6.29.0** (gondolin override)
  clears GHSA-3wwx-pv8p-q78v, GHSA-r53p-7pc4-xj5r and GHSA-rfgv-xxqx-mfg5 (high —
  DoS and response splitting).

## [0.3.1] — 2026-10-10

Context management for models that report no context window, plus dependency advisory
fixes.

### Added
- **Emergency compaction fallback ([ADR 0025]).** FIFO needs a context window, and pi
  reports no context usage for a model whose metadata has none. With compaction off (the
  fork default), such a session had no context management at all. PENpi now counts
  consecutive agent runs in which FIFO had no valid context window. After
  `emergencyCompactionRuns` of them (default `15`, `PENPI_EMERGENCY_COMPACTION_RUNS`), it
  forces one compaction via `ctx.compact()`. The run count is a minimum, not an exact
  trigger: a size gate mirroring pi's cut-point rule defers compaction until session
  history clears `keepRecentTokens`. It fires at `agent_settled`, after pi's retry and
  overflow handling, because compacting from `agent_end` would disconnect the session
  under a pending retry. Threshold compaction is still cancelled unconditionally, so
  sessions with a window keep compaction off and FIFO in charge.

### Security
- **Dependency advisories.** `vitest` 4.1.9 → **4.1.11**, with its exact peer
  `@vitest/coverage-v8`, clears GHSA-82fw-gwwq-j7x9 (moderate — path traversal and
  arbitrary file read via the `@vitest/mocker` redirect mock). `undici` 8.10.0 →
  **8.10.2** clears eleven 8.x advisories, three of them high: a DoS via an unrequested
  WebSocket subprotocol, a TLS certificate validation bypass in `BalancedPool`, and
  cross-origin cache poisoning in interceptors. The rest are moderate or low, including
  further DoS issues and downstream response splitting via the retry interceptor.
  `ip-address` 10.4.0 → **10.7.3** (transitive, via `express-rate-limit`) clears four
  moderate advisories, two of them SSRF and trust-boundary bypasses.

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

[ADR 0003]: docs/adr/0003-fifo-replaces-compaction.md
[ADR 0004]: docs/adr/0004-three-tier-memory.md
[ADR 0010]: docs/adr/0010-save-context-on-shutdown-opt-in.md
[ADR 0012]: docs/adr/0012-transcript-search-tier-3.md
[ADR 0014]: docs/adr/0014-pin-third-party-dependencies.md
[ADR 0017]: docs/adr/0017-fast-fail-timeouts.md
[ADR 0018]: docs/adr/0018-global-install.md
[ADR 0019]: docs/adr/0019-disable-upstream-update-banner.md
[ADR 0020]: docs/adr/0020-pin-managed-package-installs.md
[ADR 0021]: docs/adr/0021-optional-user-selected-web-search.md
[ADR 0023]: docs/adr/0023-overflow-compaction-escape-hatch.md
[ADR 0024]: docs/adr/0024-memory-fence-sanitization.md
[ADR 0025]: docs/adr/0025-compaction-fallback-without-fifo-window.md
[ADR 0026]: docs/adr/0026-global-only-configuration.md
[ADR 0027]: docs/adr/0027-slope-free-fifo-budget.md
[ADR 0028]: docs/adr/0028-length-continuation.md
[ADR 0029]: docs/adr/0029-sanitizer-normalization-and-bounds.md
[ADR 0030]: docs/adr/0030-strict-config-values.md
[ADR 0031]: docs/adr/0031-upstream-ancestry-and-patch-manifest.md
[ADR 0032]: docs/adr/0032-context-engine.md
