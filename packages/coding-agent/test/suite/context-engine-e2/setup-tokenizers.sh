#!/usr/bin/env bash
# Tokenizer setup for E2 and the engine suite (`npm run setup:tokenizers`). Installs js-tiktoken (o200k_base)
# and @huggingface/tokenizers from the lockfile next to this script (npm registry only), and downloads the
# GLM-5.3-Flash tokenizer files from huggingface.co at a pinned revision. Everything goes into this
# directory's git-ignored .cache/ (E2_TOK_DIR and E2_HF_DIR move it), never a shared path.
#
# The installed npm tree must match tok/install.sha256 (see tokenizer-cache.ts); an install that does not is
# removed and installed again. Each GLM file is checked by SHA-256. Idempotent: what is present and matches
# is kept.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cache="node $here/tokenizer-cache.ts"
{ read -r tok; read -r hf; } < <($cache dirs)
mkdir -p "$tok" "$hf"

# 1. npm packages (exact versions from tok/package-lock.json), checked against the pinned digest.
cp "$here/tok/package.json" "$here/tok/package-lock.json" "$tok/"
if ! $cache verify 2>/dev/null; then
	rm -rf "$tok/node_modules"
	(cd "$tok" && npm ci --ignore-scripts --no-audit --no-fund)
	$cache verify || { echo "tokenizer setup: the installed packages do not match tok/install.sha256" >&2; exit 1; }
fi

# 2. GLM-5.3-Flash files, from a pinned revision (the hashes, in tokenizer-cache.ts, pin the exact content
#    the harness was built against). "main" moved on 2026-10-15 (chat template change); 91b69215
#    (2026-10-12) still serves all four files with these hashes.
rev=91b69215804f2d2036a8867f6ce44848e278dcda
while read -r name sha; do
	file="$hf/$name"
	if [ -f "$file" ] && echo "$sha  $file" | sha256sum -c --status -; then continue; fi
	curl -fsSL "https://huggingface.co/zai-org/GLM-5.3-Flash/resolve/$rev/$name" -o "$file.part"
	mv "$file.part" "$file"
	echo "$sha  $file" | sha256sum -c -
done < <($cache hf-files)

echo "tokenizers ready: packages in $tok, GLM-5.3-Flash files in $hf"
