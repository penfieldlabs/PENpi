#!/usr/bin/env bash
# E2 in one command: tokenizer setup, engine snapshot, self-test + the full matrix
# (4 mixes x 2 tokenizers x 3 windows x {reject, silent-front, silent-messages, reasoning} = 96 runs; P3 added
# reasoning, E2_MODES=reject,silent-front,silent-messages gives the 72 runs of r5), summary.
# Exit code 0 only if the self-test passes and every run PASSes (non-zero on any FAIL or error).
#
#   test/suite/context-engine-e2/run-e2.sh                         # the engine PENpi ships (.pi/extensions/penpi/engine)
#   CONTEXT_ENGINE_BASELINE=1 test/suite/context-engine-e2/run-e2.sh   # the frozen first version
#   E2_ENGINE=/path/to/engine/index.ts E2_ENGINE_LABEL=mine test/suite/context-engine-e2/run-e2.sh   # entry file; its
#   relative imports are snapshotted with it
#
# Selection and knobs (see matrix.ts): E2_MIXES E2_TOKENIZERS E2_WINDOWS E2_MODES E2_TURNS E2_SEED
# E2_SILENT_LIMIT E2_ENGINE_OPTIONS E2_PROBE_CONFIRMATIONS; E2_WORKERS (parallel vitest workers, default 2);
# E2_OUT (results directory); E2_SKIP_SETUP=1 (tokenizers already installed); E2_SKIP_SELFTEST=1.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/../../.." && pwd)" # packages/coding-agent
started=$(date +%s)

if [ "${E2_SKIP_SETUP:-0}" != 1 ]; then
	"$here/setup-tokenizers.sh" || { echo "E2: tokenizer setup failed" >&2; exit 3; }
fi

# Resolve the engine once and snapshot it, so every worker loads the same bytes.
if [ -n "${E2_ENGINE:-}" ]; then
	src="$E2_ENGINE"; label="${E2_ENGINE_LABEL:-custom}"
elif [ "${CONTEXT_ENGINE_BASELINE:-}" = 1 ]; then
	src="${E2_BASELINE_FILE:-$here/../context-engine/reference/r1-context-engine.ts}"; label="${E2_ENGINE_LABEL:-baseline}"
else
	src="$pkg/../../.pi/extensions/penpi/engine/index.ts"; label="${E2_ENGINE_LABEL:-revised}"
fi
[ -f "$src" ] || { echo "E2: engine file $src not found" >&2; exit 3; }
src="$(realpath "$src")"
# The entry file and everything it imports, copied into .engine/<sha12>/ (snapshot-engine.ts).
snapline="$(node "$here/snapshot-engine.ts" "$src")" || { echo "E2: could not snapshot $src" >&2; exit 3; }
IFS=$'\t' read -r sha snapentry nfiles <<<"$snapline"
export E2_ENGINE="$snapentry" E2_ENGINE_LABEL="$label" E2_ENGINE_SOURCE="$src"
out="${E2_OUT:-${E2_OUT_ROOT:-$here/.cache/results}/$label-${sha:0:12}}"
export E2_OUT="$out"
mkdir -p "$out"
rm -f "$out"/*.json "$out"/*.engine.log "$out"/*.dropped.jsonl "$out"/summary.md "$out"/vitest.log
echo "E2: engine $label sha256 $sha ($nfiles files, from $src); results in $out"

# Expected number of runs for the summary check.
count() { local v="$1" d="$2"; [ -n "$v" ] && echo "$v" | tr ',' '\n' | grep -c . || echo "$d"; }
expect=$(( $(count "${E2_MIXES:-}" 4) * $(count "${E2_TOKENIZERS:-}" 2) * $(count "${E2_WINDOWS:-}" 3) * $(count "${E2_MODES:-}" 4) ))
# The default matrix (no selection, no system section): only there must every known failure's run be present.
default_matrix=0
[ -z "${E2_MIXES:-}${E2_TOKENIZERS:-}${E2_WINDOWS:-}${E2_MODES:-}${E2_SYSTEM_SECTION_TOKENS:-}" ] && default_matrix=1

files=(test/suite/context-engine-e2/e2-coding.e2.ts test/suite/context-engine-e2/e2-research.e2.ts test/suite/context-engine-e2/e2-cjk.e2.ts test/suite/context-engine-e2/e2-data.e2.ts)
[ "${E2_SKIP_SELFTEST:-0}" = 1 ] || files=(test/suite/context-engine-e2/sim.e2.ts "${files[@]}")
cd "$pkg"
npx vitest --run --config test/suite/context-engine-e2/vitest.config.ts "${files[@]}" 2>&1 | tee "$out/vitest.log"
vitest_exit=${PIPESTATUS[0]}

E2_EXPECT_RUNS=$expect E2_DEFAULT_MATRIX=$default_matrix node "$here/summarize.mjs" "$out"
summary_exit=$?
elapsed=$(( $(date +%s) - started ))
echo "E2: vitest exit $vitest_exit, summary exit $summary_exit, ${elapsed}s total; engine $label $sha; summary $out/summary.md"
[ "$vitest_exit" = 0 ] && [ "$summary_exit" = 0 ]
