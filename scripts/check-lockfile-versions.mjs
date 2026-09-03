#!/usr/bin/env node

/**
 * Asserts package-lock.json records the same versions as the package.json files
 * it mirrors.
 *
 * Bumping a version by editing package.json alone leaves the lockfile behind:
 * npm only rewrites those fields during an install, so the tree stays clean, the
 * whole gate passes, and the release ships manifests that disagree with the
 * lockfile. That happened on the 0.3.0 bump and was caught by a human reviewer
 * rather than by CI.
 *
 * The supported bump path (`npm run version:minor` and friends) already does the
 * right thing — it runs `npm install --package-lock-only` as its final step.
 * This check exists so that skipping that path fails loudly instead of silently.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const readJson = (p) => JSON.parse(readFileSync(join(repoRoot, p), "utf8"));

const lock = readJson("package-lock.json");
const failures = [];

/** Compare one package.json against the lockfile entry that mirrors it. */
function expect(label, declaredPath, lockValue) {
	const declared = readJson(declaredPath).version;
	if (declared !== lockValue) {
		failures.push(`${label}: ${declaredPath} says ${declared}, package-lock.json says ${lockValue}`);
	}
}

// The lockfile carries the root version twice: once at the top level, once as
// the "" entry in packages. Both must track the root package.json.
expect("root (lock top level)", "package.json", lock.version);
expect("root (lock packages[''])", "package.json", lock.packages?.[""]?.version);

// Every workspace the lockfile records a version for must match its manifest.
for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
	if (!lockPath || entry.link || !entry.version) continue;
	if (lockPath.includes("node_modules/")) continue; // external dependency (incl. nested), not a workspace
	expect(`workspace ${lockPath}`, join(lockPath, "package.json"), entry.version);
}

// The MCP handshake version is a hand-maintained literal in source, not a
// manifest field, so no install step can ever reconcile it. It is pinned by a
// unit test too; asserted here as well so one command covers every surface a
// release can disagree with itself on.
const handshake = readFileSync(join(repoRoot, ".pi/extensions/penpi/penfield-client.ts"), "utf8");
const handshakeMatch = handshake.match(/export const PENPI_VERSION = "([^"]+)"/);
const extensionVersion = readJson(".pi/extensions/penpi/package.json").version;
if (!handshakeMatch) {
	failures.push("penfield-client.ts: could not find PENPI_VERSION");
} else if (handshakeMatch[1] !== extensionVersion) {
	failures.push(
		`MCP handshake: penfield-client.ts says ${handshakeMatch[1]}, .pi/extensions/penpi/package.json says ${extensionVersion}`,
	);
}

// The changelog must have a section for the version being released.
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const rootVersion = readJson("package.json").version;
if (!new RegExp(`^## \\[${rootVersion.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
	failures.push(`CHANGELOG.md has no "## [${rootVersion}]" section`);
}

if (failures.length > 0) {
	console.error("Version surfaces disagree:\n");
	for (const f of failures) console.error(`  ${f}`);
	console.error("");
	console.error("Lockfile drift:   npm install --package-lock-only --ignore-scripts");
	console.error("Manifest drift:   npm run version:minor  (never edit versions by hand)");
	console.error("Handshake/CHANGELOG: edit the literal/section to match package.json");
	process.exit(1);
}

console.log(`All version surfaces agree at ${readJson("package.json").version}.`);
