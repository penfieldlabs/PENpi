import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/**
 * 0.5.1: the changelog and the docs cite ADRs as reference links ("[ADR 0032]"). Without a definition such a
 * reference renders as literal brackets, on GitHub and in the release notes.
 */
const ADR_REF_RE = /\[ADR (\d{4})\](?![(:[])/g;
const ADR_DEF_RE = /^\[ADR (\d{4})\]:\s*(\S+)/gm;

function markdownFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return markdownFiles(path);
		return entry.name.endsWith(".md") ? [path] : [];
	});
}

test("every ADR reference in the changelog, the README and docs/ has a definition that points to an existing ADR", () => {
	const problems = [];
	for (const file of ["CHANGELOG.md", "README.md", ...markdownFiles("docs")]) {
		const text = readFileSync(file, "utf8");
		const defined = new Map([...text.matchAll(ADR_DEF_RE)].map((m) => [m[1], m[2]]));
		for (const number of new Set([...text.matchAll(ADR_REF_RE)].map((m) => m[1]))) {
			const target = defined.get(number);
			if (!target) {
				problems.push(`${file}: [ADR ${number}] has no definition`);
				continue;
			}
			const resolved = join(dirname(file), target.split("#")[0]);
			if (!existsSync(resolved) || !/^\d{4}-.*\.md$/.test(basename(resolved)) || !basename(resolved).startsWith(number))
				problems.push(`${file}: [ADR ${number}] points to ${target}, not an existing ADR ${number}`);
		}
	}
	assert.deepEqual(problems, []);
});

test("release notes carry the ADR definitions their section uses, as links to the tag", () => {
	const notes = extract("0.5.0");
	for (const number of new Set([...notes.matchAll(ADR_REF_RE)].map((m) => m[1]))) {
		assert.match(
			notes,
			new RegExp(`^\\[ADR ${number}\\]: https://github\\.com/penfieldlabs/PENpi/blob/v0\\.5\\.0/docs/adr/${number}-[^\\s]+\\.md$`, "m"),
			`ADR ${number} is used in the 0.5.0 notes and must be defined there`,
		);
	}
	// Only the definitions the section uses: none for an ADR it does not cite.
	assert.doesNotMatch(notes, /^\[ADR 0014\]:/m);
});
