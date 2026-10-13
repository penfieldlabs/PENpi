import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findNonExecutable, referencedScripts } from "./check-shell-script-modes.mjs";

function git(cwd, ...args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function fixtureRepo() {
	const root = mkdtempSync(join(tmpdir(), "script-modes-"));
	git(root, "init", "-q");
	mkdirSync(join(root, ".github", "workflows"), { recursive: true });
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts", "penpi-global.sh"), "#!/usr/bin/env bash\n");
	writeFileSync(join(root, "scripts", "release.sh"), "#!/usr/bin/env bash\n");
	writeFileSync(join(root, "package.json"), "{}\n");
	writeFileSync(join(root, "README.md"), "Run `scripts/penpi-global.sh install`.\n");
	writeFileSync(join(root, ".github", "workflows", "release.yml"), "run: ./scripts/release.sh v1\n");
	git(root, "add", ".");
	return root;
}

test("finds script paths with and without a leading ./", () => {
	assert.deepEqual(
		[...referencedScripts("run ./scripts/a.sh and scripts/b.sh, not a.sh")].sort(),
		["scripts/a.sh", "scripts/b.sh"],
	);
});

test("flags an invoked script that is not executable in git", () => {
	const root = fixtureRepo();
	try {
		git(root, "update-index", "--chmod=+x", "scripts/penpi-global.sh");
		assert.deepEqual(findNonExecutable(root), [
			{ script: "scripts/release.sh", source: ".github/workflows/release.yml", mode: "100644" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("passes when every invoked script is executable", () => {
	const root = fixtureRepo();
	try {
		git(root, "update-index", "--chmod=+x", "scripts/penpi-global.sh", "scripts/release.sh");
		assert.deepEqual(findNonExecutable(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
