#!/usr/bin/env node
// Every path that differs from the upstream Pi base must be listed, with a reason, in
// docs/UPSTREAM_PATCHES.txt, and every listed path must still differ. Once main records
// upstream as merged, an unlisted difference would survive the next upstream merge
// silently as if it were a deliberate PENpi change.
//
// Compares the index (what is committed, or about to be) with the base, so the result is
// the same in CI and in a pre-commit run. Fetches the base commit by SHA when it is not
// present locally (shallow CI checkouts); no credentials are needed for a public repo.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MANIFEST = "docs/UPSTREAM_PATCHES.txt";

export function parseManifest(text) {
	let base;
	const entries = new Map();
	const errors = [];
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trimEnd();
		if (line === "" || line.startsWith("#")) continue;
		const baseMatch = /^base: ([0-9a-f]{40})\b/.exec(line);
		if (baseMatch) {
			base = baseMatch[1];
			continue;
		}
		const tab = line.indexOf("\t");
		const path = tab === -1 ? line : line.slice(0, tab);
		const reason = tab === -1 ? "" : line.slice(tab + 1).trim();
		if (!reason) errors.push(`line ${index + 1}: ${path} has no reason`);
		if (entries.has(path)) errors.push(`line ${index + 1}: ${path} is listed twice`);
		entries.set(path, reason);
	}
	if (!base) errors.push("no `base: <40-hex sha>` line");
	return { base, entries, errors };
}

/** Paths listed but not differing, and differing but not listed. `listed` is the manifest's path -> reason map. */
export function compare(listed, differing) {
	return {
		unlisted: [...differing].filter((path) => !listed.has(path)).sort(),
		stale: [...listed.keys()].filter((path) => !differing.has(path)).sort(),
	};
}

function git(repoRoot, args, options = {}) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options });
}

export function differingPaths(repoRoot, base) {
	const output = git(repoRoot, ["diff", "--cached", "--name-only", "--no-renames", "-z", base]);
	return new Set(output.split("\0").filter(Boolean));
}

function ensureBase(repoRoot, base) {
	const present = () =>
		spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: repoRoot, stdio: "ignore" }).status === 0;
	if (present()) return;
	spawnSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { cwd: repoRoot, stdio: "inherit" });
	if (!present()) throw new Error(`upstream base ${base} is not available locally and could not be fetched`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const repoRoot = resolve(import.meta.dirname, "..");
	const { base, entries, errors } = parseManifest(readFileSync(join(repoRoot, MANIFEST), "utf8"));
	if (errors.length > 0) {
		for (const error of errors) console.error(`${MANIFEST}: ${error}`);
		process.exit(1);
	}
	ensureBase(repoRoot, base);
	const { unlisted, stale } = compare(entries, differingPaths(repoRoot, base));
	if (unlisted.length > 0 || stale.length > 0) {
		for (const path of unlisted) console.error(`differs from upstream ${base.slice(0, 9)} but is not in ${MANIFEST}: ${path}`);
		for (const path of stale) console.error(`listed in ${MANIFEST} but identical to upstream: ${path}`);
		process.exit(1);
	}
	console.log(`All ${entries.size} paths that differ from upstream ${base.slice(0, 9)} are listed in ${MANIFEST}.`);
}
