#!/usr/bin/env bash
# The context engine suite against stock upstream Pi at the recorded base (the base: line of
# docs/UPSTREAM_PATCHES.txt): the engine is a plain Pi extension, so it must work without PENpi's core
# patches. Checks out the base as a detached worktree in .cache/upstream-<sha12> (git-ignored), copies the
# engine and the suite into it, installs and builds it (upstream's offline build, with the fork's
# committed model data), and runs the suite there with the tokenizer cache of this checkout
# (`npm run setup:tokenizers` first). PENpi-only tests are left out: engine-log and penpi-briefing load
# PENpi's extension, which is not part of stock Pi.
#
#   scripts/engine-suite-upstream.sh            # needs the full history (the base commit)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
base="$(awk '/^base:/ {print $2}' docs/UPSTREAM_PATCHES.txt)"
git cat-file -e "$base^{commit}" || { echo "upstream base $base is not in this clone (fetch the full history)" >&2; exit 3; }
dir="$root/.cache/upstream-${base:0:12}"
suite=packages/coding-agent/test/suite

if [ ! -d "$dir/.git" ] && [ ! -f "$dir/.git" ]; then
	mkdir -p "$root/.cache"
	git worktree add --detach "$dir" "$base"
fi
# The tree must be the base exactly, apart from what this script copies in.
git -C "$dir" checkout -q --detach "$base"
git -C "$dir" clean -qfdx -e node_modules -e '**/node_modules' -e '**/dist'
git -C "$dir" checkout -q -- .

mkdir -p "$dir/.pi/extensions/penpi"
cp -r .pi/extensions/penpi/engine "$dir/.pi/extensions/penpi/"
rm -f "$dir"/.pi/extensions/penpi/engine/*.test.ts "$dir/.pi/extensions/penpi/engine/entry.ts" \
	"$dir/.pi/extensions/penpi/engine/settings.ts" "$dir/.pi/extensions/penpi/engine/telemetry.ts"
cp -r "$suite/context-engine" "$suite/context-engine-e2" "$dir/$suite/"
rm -rf "$dir/$suite/context-engine/.cache" "$dir/$suite/context-engine-e2/.cache" "$dir/$suite/context-engine-e2/.engine"
rm -f "$dir/$suite/context-engine/engine-log.test.ts" "$dir/$suite/context-engine/penpi-briefing.test.ts"
# Upstream does not commit its model data (it hydrates it from live provider catalogs); the fork does. Its
# snapshot is data only (JSON), so the build gets fixed inputs while every line of code stays upstream's.
mkdir -p "$dir/packages/ai/src/providers/data"
cp -a packages/ai/src/providers/data/. "$dir/packages/ai/src/providers/data/"

cd "$dir"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then npm ci --ignore-scripts; fi
# The offline build, from that data; `npm run build` would regenerate it from live catalogs, which drift
# from what the base's types accept.
npm run build:offline
cd packages/coding-agent
E2_TOK_DIR="${E2_TOK_DIR:-$root/$suite/context-engine-e2/.cache/tok}" \
	npx vitest --run --config test/suite/context-engine/vitest.config.ts
