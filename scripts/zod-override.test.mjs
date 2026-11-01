import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 0.5.1: zod 3.25.76 has GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections),
 * fixed in 4.6.6 with no 3.x fix. An override gives every package zod 4.6.6, @anthropic-ai/sandbox-runtime
 * (range ^3.24.1) included, in the root lockfile and in the sandbox example extension's own.
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
	assert.ok(found.some((z) => z.file === "packages/coding-agent/examples/extensions/sandbox/package-lock.json"));
});

test("sandbox-runtime's config schema validates as it relies on, with the installed zod", async () => {
	assert.ok(atLeastFixed(JSON.parse(readFileSync("node_modules/zod/package.json", "utf8")).version));
	const { SandboxRuntimeConfigSchema } = await import("@anthropic-ai/sandbox-runtime");
	// The sandbox example extension's default configuration.
	const config = {
		network: { allowedDomains: ["npmjs.org", "*.npmjs.org", "github.com"], deniedDomains: [] },
		filesystem: { denyRead: ["~/.ssh"], allowWrite: [".", "/tmp"], denyWrite: [".env", "*.pem"] },
		ignoreViolations: { "*": ["/dev/null"] },
		mandatoryDenySearchDepth: 3,
	};
	const ok = SandboxRuntimeConfigSchema.safeParse(config);
	assert.equal(ok.success, true);
	assert.deepEqual(ok.data, config);

	// Its refinements and messages, and the issue paths its CLI prints.
	const broad = SandboxRuntimeConfigSchema.safeParse({ ...config, network: { allowedDomains: ["*.com"], deniedDomains: [] } });
	assert.equal(broad.success, false);
	assert.deepEqual(broad.error.issues.map((i) => i.path.join(".")), ["network.allowedDomains.0"]);
	assert.match(broad.error.issues[0].message, /Overly broad patterns like "\*\.com"/);
	const empty = SandboxRuntimeConfigSchema.safeParse({ ...config, filesystem: { ...config.filesystem, denyRead: [""] } });
	assert.equal(empty.success, false);
	assert.equal(empty.error.issues[0].message, "Path cannot be empty");
	const depth = SandboxRuntimeConfigSchema.safeParse({ ...config, mandatoryDenySearchDepth: 11 });
	assert.equal(depth.success, false);
	assert.deepEqual(depth.error.issues.map((i) => i.path.join(".")), ["mandatoryDenySearchDepth"]);
});
