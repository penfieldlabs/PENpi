#!/usr/bin/env bash
# CI's path filter (.github/workflows/ci.yml, the changes job): which test sets a run needs, from the paths it
# changes. Plain git, no third-party action. The jobs skip with an `if`, never a workflow-level paths filter: a
# required check that never reports blocks the merge, and a skipped job counts as passing.
#
#   upstream=true  upstream's packages/* suites: packages/**, the root package files, the lockfile, the upstream
#                  base (the base: line of docs/UPSTREAM_PATCHES.txt), or this filter and the workflow itself
#   engine=true    the engine-on-upstream job: all of the above, the engine, its suite script, or the E2 corpus pin
#                  (the e2-corpus: line)
#
# The full set, both true, on release/** branches, on tags, on the weekly or a manual run, and when the changed
# paths can't be computed (a new branch, a missing base commit).
#
# Input, from the workflow: EVENT_NAME, GIT_REF, BASE_REF (a pull request's base branch) and BASE_SHA (a pull
# request's base commit, or a push's previous head). Writes name=value lines to $GITHUB_OUTPUT, or stdout.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
emit() {
	printf 'upstream=%s\nengine=%s\n' "$1" "$2" >>"$out"
	echo "ci-changed-paths: upstream=$1 engine=$2 ($3)" >&2
}

full=""
case "${EVENT_NAME:-}" in schedule | workflow_dispatch) full="a ${EVENT_NAME} run" ;; esac
case "${GIT_REF:-}" in
	refs/tags/*) full="a tag" ;;
	refs/heads/release/*) full="a release branch" ;;
esac
case "${BASE_REF:-}" in release/*) full="a pull request into a release branch" ;; esac
base="${BASE_SHA:-}"
if [ -z "$full" ]; then
	if [ -z "$base" ] || [ -z "${base//0/}" ]; then
		full="no earlier commit to compare with"
	elif ! git cat-file -e "$base^{commit}" 2>/dev/null; then
		full="the base commit $base is not in this clone"
	fi
fi
if [ -n "$full" ]; then
	emit true true "full set: $full"
	exit 0
fi

line() { git show "$1:docs/UPSTREAM_PATCHES.txt" 2>/dev/null | grep -m1 "^$2:" || true; }
upstream=false
engine=false
why=()
while IFS= read -r path; do
	case "$path" in
		packages/* | package.json | package-lock.json | .github/workflows/ci.yml | scripts/ci-changed-paths.sh)
			upstream=true
			why+=("$path")
			;;
		.pi/extensions/penpi/engine/* | scripts/engine-suite-upstream.sh)
			engine=true
			why+=("$path")
			;;
	esac
done < <(git diff --name-only "$base" HEAD)
if [ "$(line "$base" base)" != "$(line HEAD base)" ]; then
	upstream=true
	why+=("the upstream base")
fi
[ "$(line "$base" e2-corpus)" = "$(line HEAD e2-corpus)" ] || {
	engine=true
	why+=("the E2 corpus pin")
}
[ "$upstream" = false ] || engine=true
emit "$upstream" "$engine" "${#why[@]} reason(s)${why[0]:+: ${why[*]:0:5}}"
