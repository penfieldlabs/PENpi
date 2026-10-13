#!/usr/bin/env node
/**
 * Release script for PENpi
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump PENpi's version or set an explicit version
 * 3. Update CHANGELOG.md: [Unreleased] -> [version] — date
 * 4. Regenerate release artifacts
 * 5. Run checks and tests
 * 6. Commit the release (the tag is made later, on the merged squash commit)
 * 7. Add new [Unreleased] section to changelogs
 * 8. Commit next-cycle changelog updates
 * 9. Print the manual steps that follow. This script never pushes: the release goes
 *    through a PR, and the tag is pushed by name only after the release is approved.
 *
 * PENpi does not publish to npm (the upstream @earendil-works scope isn't ours);
 * distribution is `scripts/penpi-global.sh` plus the source archive the manually
 * dispatched Release workflow builds.
 *
 * The version is PENpi's (root package.json, the extension manifest and the MCP
 * handshake literal; see scripts/penpi-version.mjs). The upstream workspace packages
 * keep upstream Pi's version: bumping them would produce an upstream tag name.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getPenpiVersion, nextVersion, setPenpiVersion } from "./penpi-version.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getPenpiVersion();
	let version;
	try {
		version = nextVersion(currentVersion, target);
	} catch (error) {
		console.error(`Error: ${error.message}.`);
		process.exit(1);
	}

	console.log(`Setting PENpi version ${currentVersion} -> ${version}...`);
	setPenpiVersion(version);
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getPenpiVersion();
}

function getChangelogs() {
	// PENpi's changelog only; packages/*/CHANGELOG.md belong to upstream Pi.
	return ["CHANGELOG.md"].filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] — ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 3. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 4. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run install-lock:coding-agent");
console.log();

// 5. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("./test.sh");
console.log();

// 6. Commit. No tag here: the release tag goes on the merged squash commit on main (step 9).
console.log("Committing...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
console.log();

// 7. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 8. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 9. Next steps. Nothing is pushed from here (see the header).
console.log(`=== Prepared release v${version} locally. Nothing was pushed. ===`);
console.log("Next, by hand (docs/TEST_PROTOCOL.md, AGENTS.pi.md):");
console.log("  1. Run the full gate from a clean checkout of this branch.");
console.log("  2. Open a PR to main; squash-merge it once CI passes.");
console.log("  3. Verify the merged tree equals the gated tree, then tag the merged commit:");
console.log(`       git tag -a v${version} <merged-commit> -m "PENpi ${version}"`);
console.log("  4. Only after the release is approved, push that one tag by name:");
console.log(`       git push <remote> v${version}`);
console.log(`  5. Dispatch the Release workflow with tag v${version}.`);
