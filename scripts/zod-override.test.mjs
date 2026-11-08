import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 0.5.1: zod 3.25.76 has GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections),
 * fixed in 4.6.6 with no 3.x fix. An override gives every package zod 4.6.6 in the root lockfile. 0.7.0: upstream
 * Pi v1.5.0 removed the sandbox example extension and its @anthropic-ai/sandbox-runtime (range ^3.24.1), whose own
 * lockfile and schema this test also checked; upstream's new packages/schema keeps zod 4.6.7 as a dev pin.
 */
const FIXED = [4, 6, 6];
const atLeastFixed = (version) => {
	const parts = version.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (parts[i] !== FIXED[i]) return parts[i] > FIXED[i];
	return true;
};

test("every tracked lockfile resolves zod to 4.6.6 or later", () => {
	const lockfiles = execFileSync("git", ["ls-files", "*package-lock.json", "*npm-shrinkwrap.json"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const found = [];
	for (const file of lockfiles) {
		const packages = JSON.parse(readFileSync(file, "utf8")).packages ?? {};
		for (const [path, entry] of Object.entries(packages)) {
			if (/(^|\/)node_modules\/zod$/.test(path)) found.push({ file, path, version: entry.version });
		}
	}
	assert.ok(found.length > 0, "zod is in the root lockfile");
	assert.deepEqual(
		found.filter((z) => !atLeastFixed(z.version)),
		[],
		"a lockfile still resolves a zod without the fix",
	);
});
