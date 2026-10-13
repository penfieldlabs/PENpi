import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(import.meta.dirname, "release.mjs"), "utf8");

test("the release script never pushes", () => {
	// Every command goes through run(...); a push may only appear in printed instructions.
	assert.doesNotMatch(source, /\brun\(\s*[`"']git push/);
	assert.doesNotMatch(source, /(execSync|spawnSync|execFileSync)\([^)]*git push/);
});

test("the release script never creates a tag", () => {
	// The tag is made by hand on the merged squash commit; it may only appear in printed steps.
	assert.doesNotMatch(source, /\brun\(\s*[`"']git tag/);
});

test("the release script reads PENpi's version, never an upstream workspace's", () => {
	assert.match(source, /from "\.\/penpi-version\.mjs"/);
	assert.doesNotMatch(source, /packages\/ai\/package\.json/);
});
