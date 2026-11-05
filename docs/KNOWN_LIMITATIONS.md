# Known limitations

These items were independently reviewed and accepted as non-blocking for PENpi's initial
public release. They remain visible here so users and contributors can make informed
choices and so accepted risk is not mistaken for a completed fix.

## Package integrity metadata

The generated coding-agent install lock contains resolved npm URLs but no `integrity`
hash for the eight internal `@earendil-works/*` workspace packages. Other registry
dependencies in the root lock are integrity-hashed. Versions and generated-lock checks
reduce accidental drift, and CI runs npm signature verification, but the missing hashes
leave weaker artifact verification for the inherited core packages.

## The Penfield token store

PENpi keeps the Penfield login (access and refresh token) in
`~/.config/penpi/penfield-tokens-<env>.json`, or the file `penpi.penfield.tokenStore` or
`PENPI_PENFIELD_TOKEN_STORE` names: mode `0600` in a `0700` folder. It writes a temporary file in
the same folder and renames it over the store, so a crash leaves the old or the new file, never
a partial one. A store that does not parse (one edited by hand) counts as no login: run
`/penpi login`. Since 0.6.1 a refresh holds a lock file beside the store (`<store>.lock`); one
left by a process that died during a refresh is taken over after 70 seconds (four times the
Penfield request timeout, `PENPI_PENFIELD_TIMEOUT_MS`, plus 10 seconds), and a session
starting in that minute may wait for it. Anything else at the lock's path (a directory, a
symbolic link), or a stale lock in a folder PENpi cannot write, makes PENpi refresh without the
lock. `/penpi logout` takes the lock, revokes the login at Penfield's revocation endpoint (the
refresh token, then the access token), then removes the store, whether or not Penfield could be
reached. Penfield ends the refresh token, so nothing can refresh with it again; an access token
already handed out keeps working until it expires, up to 24 hours. Other PENpi sessions stop
using their login at their next request, but a Penfield connection the MCP adapter already has
open keeps its bearer until then, or until it reconnects or its session ends: PENpi has no way
to close it. If Penfield could not be reached, the refresh token stays valid on the server until
it expires or is used; the logout message says so.
Uninstalling PENpi does not remove the store; its output says where it is.

## Penfield credentials and the programs PENpi starts

PENpi publishes the Penfield bearer in its own process environment as `PENFIELD_JWT`, where the
embedded MCP adapter reads it for the `penfield` entry. Pi's shell strips it, and
`PENPI_PENFIELD_API_KEY`, from the commands the agent runs. Since 0.6.1 every stdio MCP server in
the global `mcp.json` gets both empty in its environment; a server whose own `env` names one of
them keeps what it names. A program started some other way with PENpi's whole environment, by
another extension for example, still sees them.

## Global uninstall scope

`scripts/penpi-global.sh uninstall` removes PENpi's links, adapter package pin, compaction
override, and shell-profile block. It does not remove the runtime-generated
`mcpServers.penfield` entry from `~/.pi/agent/mcp.json`, because that file is shared with
user-managed MCP servers. The entry contains endpoint/configuration metadata and an
environment-variable name, not the token itself. Remove only that JSON entry manually if
complete configuration cleanup is required. Uninstall also leaves the Penfield login in the
token store, so a reinstall keeps it; run `/penpi logout` before uninstalling to remove it
(the uninstall output says where it is).

## Settings-file permissions

The PENpi installer creates a new global `settings.json` with mode `0600`, but inherited Pi
settings-writing paths can create files according to the user's umask (commonly `0644`). Do
not store credentials or other sensitive values in a world-readable settings file. Prefer
credential files with restrictive permissions or run `chmod 600 ~/.pi/agent/settings.json`.

## Test prerequisites

The complete inherited test gate requires `ripgrep` (`rg`) and `fd` **8.7.0 or newer**.
Debian/Ubuntu's `fd-find` package installs the executable as `fdfind`, so an `fd` symlink on
`PATH` is also needed. Debian stable may provide `fd` 8.6.0; that version is too old and can
produce ten failures that resemble product defects even when the command and symlink exist.
Check with `fd --version` and install a newer release when necessary. The prerequisites are
listed in the README, contributing guide, and CI workflow.

The inherited suite is also sensitive to long absolute checkout paths. The pre-release
review reproduced failures with a 96-character checkout path and a clean pass with an
18-character path; it did not establish the exact cutoff. Run the gate from a short checkout
path before treating path-related failures as product defects.

## Persistent-memory deletion and prompt injection

Penfield currently exposes no delete tool through PENpi. A bad record can be corrected or
neutralized with `update_memory` by ID, but not deleted in-product. Normal automatic
orientation marks Penfield as trusted persistent context while preventing remembered text
from overriding current instructions or independently authorizing actions. Model-level
prompt-injection defenses are not guarantees.

`--penpi-raw` is an advanced diagnostic control: it skips automatic orientation but retains
Penfield tools and the context engine. Manually recalled memory in raw mode is ordinary tool output and
does not receive the automatic persistent-memory boundary. Raw mode is not a poisoned-memory
remedy; correct or neutralize the record by ID and return to normal mode.

## Small silent truncations

A provider that silently drops part of a request is detected from the input usage it reports:
the context engine compares the reported growth with what each request added. When only a few
percent of a request is dropped, the reported usage hardly changes, and an honest request looks
the same. Such a truncation goes unseen until a larger one follows. In E2 one was 374 of 16,441
tokens (2.3%); on the 0.5.x corpus it made research.glm.32k.silent-messages fail C6 (lag 4). E2
accepts such misses inside C8's band (0.02 plus the estimate error, at most 5%); outside the band,
a truncated answer must be named.

## Extensions that change messages in Pi's `context` event

The context engine plans each request against its own record of the session. Another
extension that adds, removes or rewrites messages in Pi's `context` event makes the request's
messages differ from that record. The engine then sends Pi's messages uncut: it does not
manage the window for those requests, and a long session can outgrow it until the provider
refuses the request as too long. Since 0.6.1 the engine says so once per session, and
`/penpi doctor` counts the requests ("requests not matching the engine's record"). An extension
that changes messages this way is not compatible with the engine; remove it, or make it change
messages in another way.

## `pi mcp list` and a trusted project's MCP servers

`pi mcp list`, and Pi's other `mcp` subcommands, run Pi's own MCP handler before any
extension loads, so PENpi's protections do not apply there (ADR 0026). It reads the global
`mcp.json` and, in a trusted project, the project's `.pi/mcp.json`, and connects to each
server to show its state and tools: a command such a file defines runs. It reports the
`penfield` entry as a config error, because Pi rejects that entry's `auth` form. This was the
same in 0.5.x. A normal `pi` session, which loads PENpi, starts nothing from a project's MCP
files. Run `pi mcp` only in projects whose `.pi/mcp.json` you trust, or use `/mcp` in a session.

## Platform coverage

The pre-release review exercised install and uninstall on Linux with Bash, Zsh, and Fish;
each preserved the user's profile content and removed the PENpi block cleanly. macOS was
not independently exercised before the initial public release. FIFO's small-context
overflow fix (PENpi 0.4; the context engine has since replaced FIFO) was verified
hermetically because no funded small-context live endpoint was available to the reviewer.
