# Known limitations

These items were independently reviewed and accepted as non-blocking for PENpi's initial
public release. They remain visible here so users and contributors can make informed
choices and so accepted risk is not mistaken for a completed fix.

## Package integrity metadata

The generated coding-agent shrinkwrap and install lock contain resolved npm URLs but no
`integrity` hash for the four internal `@earendil-works/pi-*` packages. Other registry
dependencies in the root lock are integrity-hashed. Versions and generated-lock checks
reduce accidental drift, and CI runs npm signature verification, but the missing hashes
leave weaker artifact verification for the inherited core packages.

## Penfield token-store crash recovery

The OAuth token store is permission-restricted (`0700` directory, `0600` file) but written
directly rather than through temporary-file-plus-rename replacement. A process or machine
failure during that write can leave malformed JSON. PENpi then fails closed and requires a
fresh `/penpi login`; it does not attempt to recover a partially written refresh token.

## Global uninstall scope

`scripts/penpi-global.sh uninstall` removes PENpi's links, adapter package pin, compaction
override, and shell-profile block. It does not remove the runtime-generated
`mcpServers.penfield` entry from `~/.pi/agent/mcp.json`, because that file is shared with
user-managed MCP servers. The entry contains endpoint/configuration metadata and an
environment-variable name, not the token itself. Remove only that JSON entry manually if
complete configuration cleanup is required.

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
Penfield tools and FIFO. Manually recalled memory in raw mode is ordinary tool output and
does not receive the automatic persistent-memory boundary. Raw mode is not a poisoned-memory
remedy; correct or neutralize the record by ID and return to normal mode.

## Platform coverage

The pre-release review exercised install and uninstall on Linux with Bash, Zsh, and Fish;
each preserved the user's profile content and removed the PENpi block cleanly. macOS was
not independently exercised before the initial public release. FIFO's small-context
overflow fix was verified hermetically because no funded small-context live endpoint was
available to the reviewer.
