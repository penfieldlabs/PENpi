import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * 0.6.0: pi-mcp-adapter 7.x declares a peer range for @earendil-works/pi-ai that makes a plain `npm install` replace
 * the workspace link with registry copies. check-lockfile-versions fails on any registry pi-ai in the lockfile.
 */
const script = resolve("scripts/check-lockfile-versions.mjs");

/** A copy of the files the check reads, with the lockfile changed by `edit`. */
function copyRepo(edit) {
	const dir = mkdtempSync(join(tmpdir(), "penpi-lock-check-"));
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	const files = ["package.json", "CHANGELOG.md", ".pi/extensions/penpi/package.json", ".pi/extensions/penpi/penfield-client.ts"];
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (path && !entry.link && entry.version && !path.includes("node_modules/")) files.push(join(path, "package.json"));
	}
	for (const file of files) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		copyFileSync(file, join(dir, file));
	}
	edit(lock);
	writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
	return dir;
}

function check(dir) {
	const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
	rmSync(dir, { recursive: true, force: true });
	return run;
}

test("the lockfile as committed passes", () => {
	const run = check(copyRepo(() => {}));
	assert.equal(run.status, 0, run.stderr);
});

test("a registry pi-ai next to the workspace link fails", () => {
	const run = check(
		copyRepo((lock) => {
			lock.packages["packages/agent/node_modules/@earendil-works/pi-ai"] = {
				version: "1.4.0",
				resolved: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz",
			};
		}),
	);
	assert.equal(run.status, 1);
	assert.match(run.stderr, /packages\/agent\/node_modules\/@earendil-works\/pi-ai: a registry @earendil-works\/pi-ai 1\.4\.0/);
});

test("a registry pi-ai in place of the root link fails", () => {
	const run = check(
		copyRepo((lock) => {
			lock.packages["node_modules/@earendil-works/pi-ai"] = { version: "1.4.0" };
		}),
	);
	assert.equal(run.status, 1);
	assert.match(run.stderr, /^ {2}node_modules\/@earendil-works\/pi-ai: a registry/m);
});
