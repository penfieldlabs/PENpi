import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compare, differingPaths, parseManifest } from "./check-upstream-patches.mjs";

const BASE = "a".repeat(40);
const REV = "b".repeat(40);
const PRINT = "c".repeat(64);
const PIN = `e2-corpus: ${REV} ${PRINT} (upstream)\n`;

test("parses the base, the E2 corpus pin and one reasoned entry per path", () => {
	const { base, e2Corpus, entries, errors } = parseManifest(
		`# comment\nbase: ${BASE} (upstream)\n${PIN}README.md\tPENpi README\n`,
	);
	assert.equal(base, BASE);
	assert.deepEqual(e2Corpus, { rev: REV, fingerprint: PRINT });
	assert.deepEqual([...entries], [["README.md", "PENpi README"]]);
	assert.deepEqual(errors, []);
});

test("rejects a missing base and pin, a missing reason and a duplicate path", () => {
	const { errors } = parseManifest("README.md\nLICENSE\tok\nLICENSE\tagain\n");
	assert.deepEqual(errors, [
		"line 1: README.md has no reason",
		"line 3: LICENSE is listed twice",
		"no `base: <40-hex sha>` line",
		"no `e2-corpus: <40-hex revision> <64-hex fingerprint>` line",
	]);
});

test("rejects an E2 corpus pin without a full revision and fingerprint, and does not read it as a path", () => {
	const { entries, errors } = parseManifest(`base: ${BASE}\ne2-corpus: ${REV}\n`);
	assert.deepEqual([...entries], []);
	assert.deepEqual(errors, [
		"line 2: e2-corpus: needs a 40-hex revision and a 64-hex fingerprint",
		"no `e2-corpus: <40-hex revision> <64-hex fingerprint>` line",
	]);
});

test("reports unlisted and stale paths", () => {
	const listed = new Map([
		["a.ts", "r"],
		["stale.ts", "r"],
	]);
	assert.deepEqual(compare(listed, new Set(["a.ts", "new.ts"])), { unlisted: ["new.ts"], stale: ["stale.ts"] });
	assert.deepEqual(compare(listed, new Set(["a.ts", "stale.ts"])), { unlisted: [], stale: [] });
});

test("diffs the index, including additions, deletions and mode changes", () => {
	const root = mkdtempSync(join(tmpdir(), "upstream-patches-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	try {
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "test");
		for (const name of ["same.txt", "edited.txt", "removed.txt", "script.sh"]) writeFileSync(join(root, name), `${name}\n`);
		git("add", ".");
		git("commit", "-q", "-m", "base");
		const base = git("rev-parse", "HEAD").trim();
		writeFileSync(join(root, "edited.txt"), "changed\n");
		writeFileSync(join(root, "added.txt"), "new\n");
		git("rm", "-q", "removed.txt");
		git("add", "edited.txt", "added.txt");
		git("update-index", "--chmod=+x", "script.sh");
		assert.deepEqual([...differingPaths(root, base)].sort(), ["added.txt", "edited.txt", "removed.txt", "script.sh"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
