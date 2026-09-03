#!/usr/bin/env bash
#
# Build a review/release archive from TRACKED FILES ONLY, then assert it contains
# nothing that should never leave the repository.
#
# Why this exists: review archives were previously built with `zip -r . -x <denylist>`.
# A denylist only excludes what you thought to name, so the archive shipped 423 .git
# entries and two ignored 391 KB session HTML exports containing conversation data.
# `git archive` inverts that — it emits exactly what is committed, so untracked and
# ignored files cannot ride along by omission.
#
# Usage: scripts/make-review-archive.sh [ref] [output]
set -euo pipefail

ref="${1:-HEAD}"
output="${2:-$HOME/penpi-review-$(git rev-parse --short "${ref}").zip}"

repo_root="$(git rev-parse --show-toplevel)"

# Resolve the output to an absolute path BEFORE anything cd's. The manifest is
# added from a temporary directory, so a relative path would resolve against
# THAT directory: zip would silently create a second archive there, leaving the
# real one without a manifest — which the required-file assertion then rejects,
# deleting the archive and failing the release. The documented interface accepts
# relative paths, so this belongs in the helper rather than at each call site.
case "${output}" in
    /*) ;;
    *) output="${PWD}/${output}" ;;
esac

cd "${repo_root}"

if [[ -n "$(git status --porcelain)" ]]; then
    echo "Refusing to build: working tree is dirty. Commit or stash first." >&2
    echo "An archive built from a dirty tree does not correspond to any commit." >&2
    git status --short >&2
    exit 1
fi

# Peel to a COMMIT. `git rev-parse <annotated-tag>` returns the TAG OBJECT's sha,
# not the commit's. git archive and `git show <obj>:path` both peel transparently,
# so the archive contents are correct either way — but the manifest would record a
# sha that is not a commit while claiming to be one. The release workflow passes a
# tag, so this is the production path.
commit="$(git rev-parse --verify --end-of-options "${ref}^{commit}")"
# Read the version from the ARCHIVED COMMIT, not the working tree. The interface
# accepts any ref, so archiving an old tag from a newer checkout would otherwise
# record provenance that contradicts the archive's own package.json.
version="$(git show "${commit}:package.json" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
echo "Building archive from ${ref} (${commit:0:7})"

# Embed provenance. `git archive` deliberately omits .git, so without this a
# recipient holding only the zip cannot tell which commit produced it — they can
# hash the archive but cannot tie it to a ref. The manifest is generated, not
# tracked, so it never drifts from the commit it describes.
manifest_dir="$(mktemp -d)"
trap 'rm -rf "${manifest_dir}"' EXIT
cat > "${manifest_dir}/ARCHIVE_MANIFEST.json" <<MANIFEST
{
  "project": "PENpi",
  "version": "${version}",
  "commit": "${commit}",
  "ref": "${ref}",
  "archiveFormatVersion": 1,
  "generatedBy": "scripts/make-review-archive.sh",
  "contents": "tracked files at the commit above; no .git, no ignored or untracked files"
}
MANIFEST

rm -f "${output}"
git archive --format=zip -o "${output}" "${ref}"
( cd "${manifest_dir}" && zip -q "${output}" ARCHIVE_MANIFEST.json )

# --- Assertions -------------------------------------------------------------
# Anything matching these must never appear in a distributed archive. Each entry
# is a defect we have actually shipped or come close to shipping.
declare -a forbidden=(
    '(^|/)\.git/'                 # full object database, incl. withdrawn history
    'pi-session-.*\.html$'        # session exports: conversation data
    '(^|/)node_modules/'          # dependencies
    '(^|/)dist/'                  # build output
    '(^|/)\.env($|\.)'            # credentials
    '\.pem$|\.key$|id_rsa'        # keys
    'penfield-tokens.*\.json$'    # auth tokens
    '(^|/)coverage/'              # test artifacts
)

listing="$(unzip -Z1 "${output}")"
failed=0
for pattern in "${forbidden[@]}"; do
    # here-string, not a pipe: `set -o pipefail` plus grep's early exit sends
    # SIGPIPE to the writer and the pipeline reports 141 as if nothing matched.
    if matches="$(grep -E "${pattern}" <<< "${listing}" || true)"; then
        if [[ -n "${matches}" ]]; then
            echo "FORBIDDEN CONTENT (${pattern}):" >&2
            printf '%s\n' "${matches}" | head -5 | sed 's/^/    /' >&2
            failed=1
        fi
    fi
done

# Positive assertion: the archive must actually contain the project.
for required in "package.json" ".pi/extensions/penpi/index.ts" "CHANGELOG.md" "ARCHIVE_MANIFEST.json"; do
    if ! grep -qxF -- "${required}" <<< "${listing}"; then
        echo "MISSING REQUIRED FILE: ${required}" >&2
        failed=1
    fi
done

if [[ "${failed}" -ne 0 ]]; then
    rm -f "${output}"
    echo "Archive rejected and deleted." >&2
    exit 1
fi

echo "  entries: $(printf '%s\n' "${listing}" | wc -l | tr -d ' ')"
echo "  size:    $(du -h "${output}" | cut -f1)"
echo "  commit:  ${commit}"
echo "  sha256:  $(sha256sum "${output}" | cut -d' ' -f1)"
echo "  ${output}"
