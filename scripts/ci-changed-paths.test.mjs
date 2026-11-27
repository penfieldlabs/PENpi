// CI's path filter (scripts/ci-changed-paths.sh): what a change selects, and when the full set runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "ci-changed-paths.sh");
const dirs = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const gitEnv = {
	PATH: process.env.PATH,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** A repository with one commit, and a second one that writes `files`; returns it and the first commit. */
function repo(files) {
	const dir = mkdtempSync(join(tmpdir(), "ci-paths-"));
	dirs.push(dir);
	const git = (...args) => execFileSync("git", args, { cwd: dir, env: gitEnv }).toString().trim();
	const write = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	git("init", "-q", "-b", "main");
	write("docs/UPSTREAM_PATCHES.txt", "base: aaa (upstream)\ne2-corpus: bbb ccc\nREADME.md\tPENpi\n");
	write("README.md", "one\n");
	git("add", "-A");
	git("commit", "-q", "-m", "one");
	const first = git("rev-parse", "HEAD");
	for (const [path, text] of Object.entries(files)) write(path, text);
	git("add", "-A");
	git("commit", "-q", "--allow-empty", "-m", "two");
	return { dir, first };
}

function run(dir, env) {
	const outFile = join(dir, ".out");
	writeFileSync(outFile, "");
	execFileSync("bash", [script], {
		cwd: dir,
		env: { ...gitEnv, GITHUB_OUTPUT: outFile, EVENT_NAME: "pull_request", GIT_REF: "refs/pull/1/merge", ...env },
		stdio: ["ignore", "ignore", "ignore"],
	});
	return execFileSync("cat", [outFile]).toString();
}

const sel = (upstream, engine) => `upstream=${upstream}\nengine=${engine}\n`;

describe("ci-changed-paths.sh", () => {
	it("a change to the extension or the docs only: neither upstream's suites nor engine-on-upstream", () => {
		const { dir, first } = repo({ ".pi/extensions/penpi/index.ts": "x\n", "docs/NOTES.md": "x\n" });
		assert.equal(run(dir, { BASE_SHA: first }), sel(false, false));
	});

	it("a new line in the patch list, base unchanged: nothing more", () => {
		const { dir, first } = repo({
			"docs/UPSTREAM_PATCHES.txt": "base: aaa (upstream)\ne2-corpus: bbb ccc\nREADME.md\tPENpi\nNEW.md\tPENpi\n",
		});
		assert.equal(run(dir, { BASE_SHA: first }), sel(false, false));
	});

	it("the engine, its suites, its upstream script or the corpus pin: engine-on-upstream only", () => {
		for (const files of [
			{ ".pi/extensions/penpi/engine/planner.ts": "x\n" },
			{ "packages/coding-agent/test/suite/context-engine/v090-recall-hidden.test.ts": "x\n" },
			{
				".pi/extensions/penpi/engine/tools/recall.ts": "x\n",
				"packages/coding-agent/test/suite/context-engine/helpers.ts": "x\n",
			},
			{ "scripts/engine-suite-upstream.sh": "x\n" },
			{ "docs/UPSTREAM_PATCHES.txt": "base: aaa (upstream)\ne2-corpus: ddd eee\nREADME.md\tPENpi\n" },
		]) {
			const { dir, first } = repo(files);
			assert.equal(run(dir, { BASE_SHA: first }), sel(false, true), JSON.stringify(files));
		}
	});

	it("packages, the root package files, the lockfile, the base, or the filter itself: both", () => {
		for (const files of [
			{ "packages/ai/src/x.ts": "x\n" },
			// E2's unit tests run only in coding-agent's package run.
			{ "packages/coding-agent/test/suite/context-engine-e2/resume.ts": "x\n" },
			{ "vitest.base.ts": "x\n" },
			{ "test.sh": "x\n" },
			{ ".npmrc": "x\n" },
			// Beside PENpi's suites, upstream's own coding-agent tests still count.
			{ "packages/coding-agent/test/suite/context-engine/x.test.ts": "x\n", "packages/coding-agent/test/suite/harness.ts": "x\n" },
			{ "package.json": "{}\n" },
			{ "package-lock.json": "{}\n" },
			{ "docs/UPSTREAM_PATCHES.txt": "base: fff (upstream)\ne2-corpus: bbb ccc\nREADME.md\tPENpi\n" },
			{ ".github/workflows/ci.yml": "x\n" },
			{ "scripts/ci-changed-paths.sh": "x\n" },
		]) {
			const { dir, first } = repo(files);
			assert.equal(run(dir, { BASE_SHA: first }), sel(true, true), JSON.stringify(files));
		}
	});

	it("a file moved out of packages/ counts as the deletion it is", () => {
		const { dir, first } = repo({ "packages/ai/src/moved.ts": "export const x = 1;\n" });
		const git = (...args) => execFileSync("git", args, { cwd: dir, env: gitEnv }).toString().trim();
		git("mv", "packages/ai/src/moved.ts", "docs/moved.ts");
		git("commit", "-q", "-m", "move");
		const second = git("rev-parse", "HEAD~1");
		assert.equal(run(dir, { BASE_SHA: second }), sel(true, true));
		assert.ok(first);
	});

	it("the full set: release branches, tags, the weekly and manual runs, and no base to compare with", () => {
		const { dir, first } = repo({ "docs/NOTES.md": "x\n" });
		for (const env of [
			{ BASE_SHA: first, EVENT_NAME: "push", GIT_REF: "refs/heads/release/v0.9.0" },
			{ BASE_SHA: first, BASE_REF: "release/v0.9.0" },
			{ BASE_SHA: first, EVENT_NAME: "push", GIT_REF: "refs/tags/v0.9.0" },
			{ BASE_SHA: first, EVENT_NAME: "schedule", GIT_REF: "refs/heads/main" },
			{ BASE_SHA: first, EVENT_NAME: "workflow_dispatch", GIT_REF: "refs/heads/main" },
			{ BASE_SHA: "0000000000000000000000000000000000000000", EVENT_NAME: "push", GIT_REF: "refs/heads/main" },
			{ BASE_SHA: "" },
			{ BASE_SHA: "1234567890123456789012345678901234567890" },
		])
			assert.equal(run(dir, env), sel(true, true), JSON.stringify(env));
	});
});
