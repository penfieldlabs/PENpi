import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repo = resolve(import.meta.dirname, "..");
const script = join(repo, "scripts", "penpi-global.sh");

function home() {
	return mkdtempSync(join(tmpdir(), "penpi-global-test-"));
}

function run(testHome, action) {
	return spawnSync("bash", [script, action], {
		cwd: repo,
		env: { ...process.env, HOME: testHome, SHELL: "/bin/bash", PI_CODING_AGENT_DIR: join(testHome, ".pi", "agent") },
		encoding: "utf8",
	});
}

function settingsPath(testHome) {
	return join(testHome, ".pi", "agent", "settings.json");
}

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

for (const [name, original] of [
	["trailing-comma", '{"theme":"dark",}'],
	["truncated", '{"theme":"dark"'],
	["empty", ""],
]) {
	test(`install rejects ${name} settings without touching them or reporting success`, () => {
		const testHome = home();
		const path = settingsPath(testHome);
		write(path, original);
		const result = run(testHome, "install");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /refusing to rewrite malformed settings/i);
		assert.doesNotMatch(result.stdout, /installed globally/i);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(existsSync(join(testHome, ".local", "bin", "pi")), false);
		assert.equal(existsSync(join(testHome, ".bashrc")), false);
	});
}

for (const [name, value] of [
	["array", []],
	["null", null],
	["string", "settings"],
]) {
	test(`install rejects a ${name} settings root without false success`, () => {
		const testHome = home();
		const path = settingsPath(testHome);
		const original = JSON.stringify(value);
		write(path, original);
		const result = run(testHome, "install");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /JSON root must be an object/i);
		assert.doesNotMatch(result.stdout, /installed globally/i);
		assert.equal(readFileSync(path, "utf8"), original);
	});
}

test("install atomically merges valid settings and preserves unknown fields", () => {
	const testHome = home();
	const path = settingsPath(testHome);
	write(path, `${JSON.stringify({ theme: "midnight", apiKeys: { example: "placeholder" }, customField: [1, 2] })}\n`);
	const result = run(testHome, "install");
	assert.equal(result.status, 0, result.stderr);
	const settings = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(settings.theme, "midnight");
	assert.deepEqual(settings.apiKeys, { example: "placeholder" });
	assert.deepEqual(settings.customField, [1, 2]);
	assert.equal(settings.compaction.enabled, false);
	assert.ok(settings.packages.includes("npm:pi-mcp-adapter@2.10.0"));
});

test("install refuses a symbolic-link settings file", () => {
	const testHome = home();
	const target = join(testHome, "sensitive.json");
	const path = settingsPath(testHome);
	write(target, '{"refresh_token":"synthetic-review-marker"}');
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path);
	const result = run(testHome, "install");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symbolic-link settings/i);
	assert.equal(lstatSync(path).isSymbolicLink(), true);
	assert.equal(readFileSync(target, "utf8"), '{"refresh_token":"synthetic-review-marker"}');
});

test("uninstall refuses an incomplete profile block before changing installation state", () => {
	const testHome = home();
	assert.equal(run(testHome, "install").status, 0);
	const profile = join(testHome, ".bashrc");
	const broken = readFileSync(profile, "utf8").replace("#PENPI_GLOBAL_END\n", "trailing-user-setting=keep\n");
	writeFileSync(profile, broken);
	const beforeSettings = readFileSync(settingsPath(testHome), "utf8");
	const result = run(testHome, "uninstall");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /incomplete, duplicated, or reversed PENpi block/i);
	assert.doesNotMatch(result.stdout, /install removed/i);
	assert.equal(readFileSync(profile, "utf8"), broken);
	assert.equal(readFileSync(settingsPath(testHome), "utf8"), beforeSettings);
	assert.equal(lstatSync(join(testHome, ".local", "bin", "pi")).isSymbolicLink(), true);
});

test("valid uninstall removes only the bounded profile block", () => {
	const testHome = home();
	assert.equal(run(testHome, "install").status, 0);
	const profile = join(testHome, ".bashrc");
	writeFileSync(profile, `${readFileSync(profile, "utf8")}AFTER_PENPI=keep\n`);
	const result = run(testHome, "uninstall");
	assert.equal(result.status, 0, result.stderr);
	const after = readFileSync(profile, "utf8");
	assert.equal(after, "AFTER_PENPI=keep\n");
	assert.equal(existsSync(join(testHome, ".local", "bin", "pi")), false);
});

test("a profile without a trailing newline remains valid and uninstallable", () => {
	const testHome = home();
	const profile = join(testHome, ".bashrc");
	writeFileSync(profile, "export LASTLINE=1");
	const installed = run(testHome, "install");
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(readFileSync(profile, "utf8"), /^export LASTLINE=1\n#PENPI_GLOBAL_BEGIN$/m);
	const uninstalled = run(testHome, "uninstall");
	assert.equal(uninstalled.status, 0, uninstalled.stderr);
	assert.equal(readFileSync(profile, "utf8"), "export LASTLINE=1\n");
});

test("install and uninstall are idempotent", () => {
	const testHome = home();
	assert.equal(run(testHome, "install").status, 0);
	assert.equal(run(testHome, "install").status, 0);
	const profile = readFileSync(join(testHome, ".bashrc"), "utf8");
	assert.equal(profile.match(/#PENPI_GLOBAL_BEGIN/g)?.length, 1);
	const settings = JSON.parse(readFileSync(settingsPath(testHome), "utf8"));
	assert.equal(settings.packages.filter((x) => x === "npm:pi-mcp-adapter@2.10.0").length, 1);
	assert.equal(run(testHome, "uninstall").status, 0);
	assert.equal(run(testHome, "uninstall").status, 0);
});

test("installer remains valid Bash", () => {
	execFileSync("bash", ["-n", script]);
});
