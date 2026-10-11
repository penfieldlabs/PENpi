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
import { fileURLToPath } from "node:url";
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
	assert.equal(settings.packages, undefined, "install must not add a packages list");
});

test("install removes a stock pi-mcp-adapter package left by an earlier install", () => {
	// PENpi embeds the adapter with a global-only config (ADR 0026). A stock copy
	// still loaded by pi would read project .mcp.json / .pi/mcp.json.
	const testHome = home();
	const path = settingsPath(testHome);
	write(path, JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.12.1", "npm:pi-web-tools@1.0.0", "npm:pi-mcp-adapter"] }));
	const result = run(testHome, "install");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).packages, ["npm:pi-web-tools@1.0.0"]);
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
	assert.equal(settings.compaction.enabled, false);
	assert.equal(settings.packages, undefined);
	assert.equal(run(testHome, "uninstall").status, 0);
	assert.equal(run(testHome, "uninstall").status, 0);
});

test("installer remains valid Bash", () => {
	execFileSync("bash", ["-n", script]);
});

test("the adapter is pinned once, as a PENpi dependency, and never as a stock package", () => {
	// PENpi embeds the adapter (ADR 0026). Listing the stock package in settings
	// again would load a second copy that reads project MCP config.
	const root = fileURLToPath(new URL("..", import.meta.url));
	const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
	const fromPenpi = read(".pi/extensions/penpi/package.json").dependencies?.["pi-mcp-adapter"];
	const fromRoot = read("package.json").devDependencies?.["pi-mcp-adapter"];
	assert.ok(fromPenpi, "pi-mcp-adapter must be a dependency of the penpi extension");
	assert.equal(fromRoot, fromPenpi, "the root devDependency and the PENpi dependency pin different adapter versions");

	assert.equal(
		(read(".pi/settings.json").packages ?? []).some((p) => p.includes("pi-mcp-adapter")),
		false,
		".pi/settings.json must not list the stock pi-mcp-adapter package",
	);
	assert.doesNotMatch(readFileSync(join(root, "scripts/penpi-global.sh"), "utf8"), /npm:pi-mcp-adapter@/);

	// 2.12.0 added runtime hot-registration of direct tools, which is what makes
	// them available on a clean install's first message rather than after a
	// restart. Anything older reintroduces that defect.
	const [major, minor] = fromPenpi.split(".").map(Number);
	assert.ok(major > 2 || (major === 2 && minor >= 12), `adapter ${fromPenpi} predates hot-registration (2.12.0)`);
});
