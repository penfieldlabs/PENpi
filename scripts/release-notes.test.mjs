import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The release workflow publishes whatever this script emits. When it cannot find
 * the requested version's section it falls back to a bare "Release <version>"
 * string with no error, so a broken invocation ships silently. That is what
 * happened for 0.2.0 and 0.3.0: the heading matcher required an ASCII hyphen
 * while PENpi's changelog dates use an em dash, so no section ever matched.
 */
function extractStrict(version) {
	const out = join(mkdtempSync(join(tmpdir(), "rn-")), "notes.md");
	return execFileSync(
		"node",
		[
			"scripts/release-notes.mjs", "extract",
			"--version", version, "--tag", `v${version}`,
			"--changelog", "CHANGELOG.md", "--repo", "penfieldlabs/PENpi", "--base-path", ".",
			"--strict", "--out", out,
		],
		{ encoding: "utf8" },
	);
}

function extract(version) {
	const out = join(mkdtempSync(join(tmpdir(), "rn-")), "notes.md");
	execFileSync(
		"node",
		[
			"scripts/release-notes.mjs",
			"extract",
			"--version",
			version,
			"--tag",
			`v${version}`,
			"--changelog",
			"CHANGELOG.md",
			"--repo",
			"penfieldlabs/PENpi",
			"--base-path",
			".",
			"--out",
			out,
		],
		{ encoding: "utf8" },
	);
	return readFileSync(out, "utf8");
}

test("finds an em-dash dated heading (PENpi's own changelog format)", () => {
	const notes = extract("0.2.0");
	assert.doesNotMatch(notes, /^Release 0\.2\.0\s*$/);
	assert.match(notes, /### (Added|Fixed|Security)/);
});

test("finds an Unreleased heading", () => {
	const notes = extract("0.3.0");
	assert.doesNotMatch(notes, /^Release 0\.3\.0\s*$/);
	assert.match(notes, /### (Added|Fixed|Changed)/);
});

test("never silently emits the placeholder when a section exists", () => {
	for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
		const notes = extract(version).trim();
		assert.notEqual(notes, `Release ${version}`, `version ${version} fell through to the placeholder`);
	}
});

test("strict mode succeeds when the section exists", () => {
	assert.doesNotThrow(() => extractStrict("0.3.0"));
});

test("strict mode FAILS on a missing section instead of emitting the placeholder", () => {
	// Testing only versions that exist cannot pin fail-closed behaviour: the
	// placeholder path exits 0, so a broken invocation looks exactly like success.
	assert.throws(() => extractStrict("9.9.9"), /No changelog section found for 9\.9\.9/);
});
