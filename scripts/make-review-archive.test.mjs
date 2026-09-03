import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = resolve(fileURLToPath(new URL("./make-review-archive.sh", import.meta.url)));

/** A throwaway repo with two commits whose package.json versions differ. */
function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "mra-"));
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");

	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "penpi-test", version: "0.3.0" }, null, "\t"));
	writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
	execFileSync("mkdir", ["-p", join(dir, ".pi/extensions/penpi")]);
	writeFileSync(join(dir, ".pi/extensions/penpi/index.ts"), "export {};\n");
	git("add", "-A");
	git("commit", "-qm", "old");
	const oldCommit = git("rev-parse", "HEAD").trim();

	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "penpi-test", version: "0.4.0" }, null, "\t"));
	git("add", "-A");
	git("commit", "-qm", "new");

	return { dir, oldCommit };
}

const run = (dir, args) => spawnSync("bash", [helper, ...args], { cwd: dir, encoding: "utf8" });
const listing = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n");

test("a RELATIVE output path produces a complete archive", () => {
	// The release workflow passes a relative path. The manifest is added from a
	// temporary directory, so a relative output resolved against that directory
	// instead: zip wrote a second archive there, the real one had no manifest, and
	// the required-file assertion deleted it. The workflow then failed before
	// publishing anything.
	const { dir } = makeRepo();
	const result = run(dir, ["HEAD", "candidate.zip"]);
	assert.equal(result.status, 0, `helper failed:\n${result.stdout}\n${result.stderr}`);

	const zip = join(dir, "candidate.zip");
	assert.ok(existsSync(zip), "archive was not created in the working directory");

	const files = listing(zip);
	assert.ok(files.includes("ARCHIVE_MANIFEST.json"), "manifest missing from the archive");
	assert.ok(files.includes("package.json"), "source missing from the archive");
});

test("an ABSOLUTE output path still works", () => {
	const { dir } = makeRepo();
	const out = join(mkdtempSync(join(tmpdir(), "mra-out-")), "abs.zip");
	const result = run(dir, ["HEAD", out]);
	assert.equal(result.status, 0, `helper failed:\n${result.stdout}\n${result.stderr}`);
	assert.ok(listing(out).includes("ARCHIVE_MANIFEST.json"));
});

test("the manifest records the ARCHIVED ref's version, not the working tree's", () => {
	// The interface accepts any ref. Reading package.json from the checkout meant
	// archiving an old tag from a newer HEAD recorded provenance that contradicted
	// the archive's own contents.
	const { dir, oldCommit } = makeRepo();
	const result = run(dir, [oldCommit, "old.zip"]);
	assert.equal(result.status, 0, `helper failed:\n${result.stdout}\n${result.stderr}`);

	const zip = join(dir, "old.zip");
	const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "ARCHIVE_MANIFEST.json"], { encoding: "utf8" }));
	const archived = JSON.parse(execFileSync("unzip", ["-p", zip, "package.json"], { encoding: "utf8" }));

	assert.equal(manifest.version, archived.version, "manifest version disagrees with the archived package.json");
	assert.equal(manifest.version, "0.3.0", "expected the older ref's version, not the checkout's 0.4.0");
	assert.equal(manifest.commit, oldCommit);
});

test("a dirty working tree is refused", () => {
	const { dir } = makeRepo();
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "penpi-test", version: "9.9.9" }));
	const result = run(dir, ["HEAD", "dirty.zip"]);
	assert.notEqual(result.status, 0, "a dirty tree must not produce an archive");
	assert.match(result.stderr, /working tree is dirty/);
	assert.ok(!existsSync(join(dir, "dirty.zip")));
});

test("forbidden content is rejected and the archive deleted", () => {
	const { dir } = makeRepo();
	// A tracked file matching the forbidden list must still be caught: the
	// allowlist is about what git tracks, the assertions are the second line.
	execFileSync("mkdir", ["-p", join(dir, "packages/coding-agent")]);
	writeFileSync(join(dir, "packages/coding-agent/pi-session-2026-01-01T00-00-00Z_x.html"), "<html></html>");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "add session export"], { cwd: dir });

	const result = run(dir, ["HEAD", "leak.zip"]);
	assert.notEqual(result.status, 0, "an archive containing a session export must be rejected");
	assert.match(result.stderr, /FORBIDDEN CONTENT/);
	assert.ok(!existsSync(join(dir, "leak.zip")), "the rejected archive must be deleted");
});

test("an ANNOTATED TAG records the commit sha, not the tag-object sha", () => {
	// The release workflow passes a tag. `git rev-parse <annotated-tag>` returns the
	// TAG OBJECT's sha; git archive and `git show <obj>:path` peel it transparently,
	// so the archive contents were right while the manifest recorded a sha that is
	// not a commit at all. Every other case here uses HEAD or a raw commit and so
	// cannot exercise the production path.
	const { dir } = makeRepo();
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	git("tag", "-a", "v9.9.9", "-m", "release");

	const tagObject = git("rev-parse", "v9.9.9");
	const taggedCommit = git("rev-parse", "v9.9.9^{commit}");
	assert.notEqual(tagObject, taggedCommit, "fixture is invalid: the tag must be annotated");
	assert.equal(execFileSync("git", ["cat-file", "-t", "v9.9.9"], { cwd: dir, encoding: "utf8" }).trim(), "tag");

	const result = run(dir, ["v9.9.9", "tagged.zip"]);
	assert.equal(result.status, 0, `helper failed:\n${result.stdout}\n${result.stderr}`);

	const manifest = JSON.parse(
		execFileSync("unzip", ["-p", join(dir, "tagged.zip"), "ARCHIVE_MANIFEST.json"], { encoding: "utf8" }),
	);
	assert.equal(manifest.commit, taggedCommit, "manifest must record the commit the tag points at");
	assert.notEqual(manifest.commit, tagObject, "manifest must not record the tag object's sha");
	assert.equal(manifest.ref, "v9.9.9", "the original ref is still recorded informationally");
});
