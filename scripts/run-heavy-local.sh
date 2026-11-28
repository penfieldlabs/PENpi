#!/usr/bin/env bash
# The heavy test runs on a local machine (macOS on Apple Silicon, or Linux), isolated as ./test.sh is, with one
# compact bundle to hand back. Portable bash: it runs on the bash 3.2 macOS ships, and uses no flock, timeout,
# /proc, readlink -f, GNU sed -i or GNU date on macOS.
#
#   scripts/run-heavy-local.sh [--parts engine,honest,e2] [--workers N] [--out DIR] [--honest-seeds N]
#                              [--engine-files "f1 f2"] [--set NAME=VALUE]...
#
# Parts (default engine,honest,e2):
#   engine    the full engine suite (npm run test:context-engine)
#   honest    the honest test's full run, in each profile (shipped, exact, claude), on its three corpora (below),
#             then the Power bar over the shipped profile's parts
#   e2        E2's default matrix (every mix, tokenizer, window and mode) on the pinned corpus (e2-corpus:)
#   e2-exact  E2's exact mode on the o200k silent runs, on the pinned corpus (not in the default set)
#
# --workers N overrides the workers chosen from the machine's cores and memory. --honest-seeds N runs only the
# first N seeds of each corpus's range; --engine-files names engine suite files; --set passes an E2_ or HONEST_
# selection variable (E2_MIXES, E2_MODES, HONEST_MIXES, ...) to the parts. These three are for a short trial
# run; a bundle made with them says so.
#
# Before it starts: the checkout must be clean, Node must be 22, node_modules must be installed (npm ci), and
# the honest and E2 parts need the upstream history holding their corpora (a full clone; a shallow one fails).
# Each part runs with env -i, an empty temporary home and no API keys. The tokenizer setup downloads only from
# the npm registry (the lockfile's packages) and huggingface.co (files at pinned revisions, checked by hash).
#
# On Linux, PENPI_HEAVY_LOCK=<file> runs each part under flock on that file, and PENPI_MEMGUARD=<script> under that
# memory guard, when flock and the script are there. The bundle holds no home paths, user names or host names.
set -o pipefail

die() {
	echo "run-heavy-local: $*" >&2
	exit 2
}

root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root" || die "cannot enter the checkout"

parts="engine,honest,e2"
workers=""
out=""
honest_seeds=""
engine_files=""
sets=""
trial=""
while [ $# -gt 0 ]; do
	case "$1" in
		--parts) parts="$2"; shift 2 ;;
		--workers) workers="$2"; shift 2 ;;
		--out) out="$2"; shift 2 ;;
		--honest-seeds) honest_seeds="$2"; trial="yes"; shift 2 ;;
		--engine-files) engine_files="$2"; trial="yes"; shift 2 ;;
		--set)
			case "$2" in
				E2_OUT=* | E2_SCRATCH=* | E2_FRESH=* | HONEST_OUT=* | HONEST_DETECTION=*) die "--set $2: not a selection variable" ;;
				E2_*=* | HONEST_*=*) sets="$sets $2"; trial="yes" ;;
				*) die "--set $2: only E2_ and HONEST_ selection variables" ;;
			esac
			shift 2
			;;
		-h | --help) sed -n '2,30p' "$0"; exit 0 ;;
		*) die "unknown argument $1 (see --help)" ;;
	esac
done
for p in $(echo "$parts" | tr ',' ' '); do
	case "$p" in engine | honest | e2 | e2-exact) ;; *) die "unknown part $p (engine, honest, e2, e2-exact)" ;; esac
done
has() { case ",$parts," in *",$1,"*) return 0 ;; esac; return 1; }

# ---------------------------------------------------------------- refusals
[ -z "$(git status --porcelain --untracked-files=normal)" ] || die "the checkout is not clean; commit or stash first"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || die "node not found"
[ "$node_major" = 22 ] || die "Node $(node -v) found; these runs need Node 22"
[ -d node_modules ] || die "node_modules is missing; run npm ci first"
commit="$(git rev-parse HEAD)"
# The honest test's corpora, one per seed range: upstream Pi v1.4.0, v1.5.0 and v1.5.1 (v1.6.0 is held out).
honest_corpora="4a080252f:0-16 f9a263655:17-33 dd30101cf:34-49"
e2_corpus="$(awk '/^e2-corpus:/ {print $2}' docs/UPSTREAM_PATCHES.txt)"
need_rev() {
	git cat-file -e "$1^{commit}" 2>/dev/null ||
		die "the $2 part reads its corpus from upstream commit $1, which this checkout doesn't hold. It needs the full history: clone without --depth, or run git fetch --unshallow"
}
if has honest; then for c in $honest_corpora; do need_rev "${c%%:*}" honest; done; fi
if has e2 || has e2-exact; then need_rev "$e2_corpus" e2; fi

# ---------------------------------------------------------------- the machine
os="$(uname -s)"
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
if [ "$os" = Darwin ]; then
	mem_kb=$(($(sysctl -n hw.memsize) / 1024))
	cpu="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
	os_name="macOS $(sw_vers -productVersion 2>/dev/null)"
else
	mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
	cpu="$(awk -F': ' '/^model name/ {print $2; exit}' /proc/cpuinfo)"
	os_name="$os $(uname -r)"
fi
mem_gb=$((mem_kb / 1048576))
if [ -z "$workers" ]; then
	# A worker holds a Pi session and up to two tokenizers: about 2 GB each, and one core left free.
	workers=$((cores - 1))
	[ $((mem_gb / 2)) -lt "$workers" ] && workers=$((mem_gb / 2))
	[ "$workers" -ge 1 ] || workers=1
fi
case "$workers" in *[!0-9]* | "") die "--workers needs a number" ;; esac

stamp="$(date +%Y%m%d-%H%M%S)"
[ -n "$out" ] || out="$root/.cache/heavy/${commit:0:12}-$stamp"
mkdir -p "$out" || die "cannot create $out"
out="$(cd "$out" && pwd -P)"

# ---------------------------------------------------------------- isolation, as ./test.sh does
work="$(mktemp -d "${TMPDIR:-/tmp}/penpi-heavy.XXXXXX")" || die "mktemp failed"
mkdir -p "$work/home/.config" "$work/tmp" "$work/cache/npm"
trap 'rm -rf "$work"' EXIT
iso="PATH=$PATH HOME=$work/home USERPROFILE=$work/home TMPDIR=$work/tmp TMP=$work/tmp TEMP=$work/tmp"
iso="$iso XDG_CONFIG_HOME=$work/home/.config XDG_CACHE_HOME=$work/cache LANG=C LC_ALL=C TZ=UTC"
iso="$iso GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 NPM_CONFIG_CACHE=$work/cache/npm"
iso="$iso PI_NO_LOCAL_LLM=1 AWS_EC2_METADATA_DISABLED=true"
[ -z "${NODE_EXTRA_CA_CERTS:-}" ] || iso="$iso NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS"

wrap=""
if [ -n "${PENPI_HEAVY_LOCK:-}" ] && command -v flock >/dev/null 2>&1; then wrap="flock $PENPI_HEAVY_LOCK"; fi
if [ -n "${PENPI_MEMGUARD:-}" ] && [ -x "$PENPI_MEMGUARD" ]; then wrap="$wrap $PENPI_MEMGUARD"; fi

results="$out/results.txt"
: >"$results"
# step <name> <log> <dir> <command...>: one step, isolated; appends "name<TAB>rc<TAB>seconds" to the results.
step() {
	name="$1"; log="$2"; dir="$3"; shift 3
	echo "run-heavy-local: $name ($(date +%H:%M:%S))"
	started=$(date +%s)
	# shellcheck disable=SC2086 # $wrap and $iso are word lists.
	(cd "$dir" && $wrap env -i $iso $sets "$@") >"$log" 2>&1
	rc=$?
	printf '%s\t%s\t%s\n' "$name" "$rc" $(($(date +%s) - started)) >>"$results"
	return $rc
}

cd "$root" || exit 2
step setup "$out/setup.log" "$root" npm run setup:tokenizers
setup_rc=$?
pkg="$root/packages/coding-agent"
engine_sha="$(node packages/coding-agent/test/suite/context-engine-e2/snapshot-engine.ts "$root/.pi/extensions/penpi/engine/index.ts" | cut -f1)"

if [ "$setup_rc" = 0 ]; then
	if has engine; then
		# shellcheck disable=SC2086 # the file list.
		step engine "$out/engine.log" "$pkg" npx vitest --run --config test/suite/context-engine/vitest.config.ts \
			--maxWorkers="$workers" $engine_files
	fi
	if has honest; then
		for profile in shipped exact claude; do
			p="$profile"
			[ "$p" = shipped ] && p=""
			for c in $honest_corpora; do
				rev="${c%%:*}"
				seeds="${c#*:}"
				if [ -n "$honest_seeds" ]; then
					from="${seeds%-*}"
					seeds="$from-$((from + honest_seeds - 1))"
				fi
				step "honest $profile $rev $seeds" "$out/honest-$profile-$rev.log" "$pkg" \
					HONEST_DETECTION=1 HONEST_PROFILE="$p" HONEST_SEEDS="$seeds" E2_CORPUS_REV="$rev" \
					HONEST_OUT="$out/honest-$profile/$rev" \
					npx vitest --run --config test/suite/context-engine/vitest.config.ts \
					test/suite/context-engine/v090-honest-detection.test.ts
			done
		done
		if [ -z "$honest_seeds" ]; then
			step "honest Power, summed" "$out/honest-power.log" "$pkg" HONEST_POWER_SUM=1 HONEST_OUT="$out/honest-shipped" \
				npx vitest --run --config test/suite/context-engine/vitest.config.ts \
				test/suite/context-engine/v090-honest-detection.test.ts
		fi
	fi
	if has e2; then
		step e2 "$out/e2.log" "$pkg" E2_SKIP_SETUP=1 E2_WORKERS="$workers" E2_OUT="$out/e2" \
			test/suite/context-engine-e2/run-e2.sh
	fi
	if has e2-exact; then
		step e2-exact "$out/e2-exact.log" "$pkg" E2_SKIP_SETUP=1 E2_WORKERS="$workers" E2_OUT="$out/e2-exact" \
			E2_EXACT=1 PENPI_TOKENIZER=local E2_ENGINE_LABEL=exact E2_TOKENIZERS=o200k \
			E2_MODES=silent-front,silent-messages test/suite/context-engine-e2/run-e2.sh
	fi
fi

# ---------------------------------------------------------------- the bundle
bundle="$out/bundle.md"
user="$(id -un 2>/dev/null)"
host="$(uname -n 2>/dev/null)"
host_short="${host%%.*}"
# A name under three characters would match inside ordinary words; such a name isn't scrubbed.
[ ${#user} -ge 3 ] || user=""
[ ${#host} -ge 3 ] || host=""
[ ${#host_short} -ge 3 ] || host_short=""
esc="$(printf '\033')"
# Terminal colours out; home paths, the checkout's path, the temp folder, user and host names, as placeholders.
scrub() {
	sed -e "s/$esc\[[0-9;]*m//g" -e "s|$work|<temp>|g" -e "s|$out|<out>|g" -e "s|$root|<checkout>|g" -e "s|$HOME|~|g" \
		${user:+-e "s|$user|<user>|g"} ${host:+-e "s|$host|<host>|g"} ${host_short:+-e "s|$host_short|<host>|g"}
}
failures() { grep -aE '^ *(FAIL|×) |^not ok |AssertionError' "$1" 2>/dev/null | head -12 | sed -e 's/^ *//' -e 's/^/    /'; }
{
	echo "# PENpi heavy local run"
	echo
	echo "- commit: $commit"
	echo "- engine files: sha256 $engine_sha"
	echo "- machine: $os_name, $(uname -m), $cpu, $cores cores, $mem_gb GB"
	echo "- Node: $(node -v); workers: $workers"
	echo "- parts: $parts$([ -n "$trial" ] && echo " (a trial selection:${honest_seeds:+ honest seeds $honest_seeds a corpus;}${engine_files:+ engine files $engine_files;}${sets:+ set$sets})")"
	echo "- started: $stamp"
	echo
	echo "| step | result | time |"
	echo "|---|---|---|"
	while IFS="$(printf '\t')" read -r name rc secs; do
		echo "| $name | $([ "$rc" = 0 ] && echo pass || echo "**fail** (exit $rc)") | ${secs} s |"
	done <"$results"
	echo
	for log in "$out"/*.log; do
		[ -f "$log" ] || continue
		tail="$(grep -aE 'Test Files |Tests |^# (pass|fail)|Power: ' "$log" | tail -4 | sed -e 's/^ *//')"
		f="$(failures "$log")"
		[ -n "$tail$f" ] || continue
		echo "**$(basename "$log" .log):** $(echo "$tail" | tr '\n' ';' | sed -e 's/;$//' -e 's/;/; /g')"
		[ -z "$f" ] || { echo; echo "$f"; }
		echo
	done
	for d in e2 e2-exact; do
		[ -f "$out/$d/summary.json" ] || continue
		echo "## E2 ($d)"
		echo
		grep -aE '^- runs:' "$out/$d/summary.md" | head -1
		echo
		node -e '
			const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
			const silent = (s.runs ?? []).filter((r) => r.silent);
			if (silent.length) {
				console.log("| silent run | verdict | truncated | lag |");
				console.log("|---|---|---|---|");
				for (const r of silent)
					console.log(`| ${r.id} | ${r.verdict} | ${r.silent.truncated ?? "-"} | ${r.silent.lagToDetection ?? "undetected"} |`);
			}
			const fails = (s.runs ?? []).filter((r) => r.verdict !== "PASS").map((r) => r.id);
			if (fails.length) console.log(`\nNot passing: ${fails.join(", ")}`);
		' "$out/$d/summary.json"
		echo
	done
} | scrub >"$bundle"
echo "run-heavy-local: bundle $bundle"
awk -F'\t' '$2 != 0 { bad = 1 } END { exit bad }' "$results"
