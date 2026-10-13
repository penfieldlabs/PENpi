import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getPenpiVersion, nextVersion, setPenpiVersion } from "./penpi-version.mjs";

const repo = resolve(import.meta.dirname, "..");

test("reads PENpi's version from the root manifest, not an upstream workspace", () => {
	const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
	const ai = JSON.parse(readFileSync(join(repo, "packages", "ai", "package.json"), "utf8")).version;
	assert.equal(getPenpiVersion(repo), root);
	assert.notEqual(getPenpiVersion(repo), ai, "fixture premise: PENpi and upstream versions differ");
});

test("resolves bump types and explicit versions", () => {
	assert.equal(nextVersion("0.4.0", "patch"), "0.4.1");
	assert.equal(nextVersion("0.4.0", "minor"), "0.5.0");
	assert.equal(nextVersion("0.4.0", "major"), "1.0.0");
	assert.equal(nextVersion("0.4.0", "0.4.1"), "0.4.1");
	assert.throws(() => nextVersion("0.4.0", "0.4.0"), /must be greater/);
	assert.throws(() => nextVersion("0.4.0", "v0.4.1"), /invalid release target/);
});

test("writes every PENpi surface and leaves upstream workspaces alone", () => {
	const root = mkdtempSync(join(tmpdir(), "penpi-version-"));
	try {
		mkdirSync(join(root, ".pi", "extensions", "penpi"), { recursive: true });
		mkdirSync(join(root, "packages", "ai"), { recursive: true });
		writeFileSync(join(root, "package.json"), '{\n\t"name": "pi-monorepo",\n\t"version": "0.4.0"\n}\n');
		writeFileSync(join(root, ".pi/extensions/penpi/package.json"), '{\n\t"name": "penpi",\n\t"version": "0.4.0"\n}\n');
		writeFileSync(join(root, ".pi/extensions/penpi/penfield-client.ts"), 'export const PENPI_VERSION = "0.4.0";\n');
		writeFileSync(join(root, "packages/ai/package.json"), '{\n\t"version": "1.1.0"\n}\n');

		setPenpiVersion("0.4.1", root);

		assert.equal(readFileSync(join(root, "package.json"), "utf8"), '{\n\t"name": "pi-monorepo",\n\t"version": "0.4.1"\n}\n');
		assert.equal(JSON.parse(readFileSync(join(root, ".pi/extensions/penpi/package.json"), "utf8")).version, "0.4.1");
		assert.equal(
			readFileSync(join(root, ".pi/extensions/penpi/penfield-client.ts"), "utf8"),
			'export const PENPI_VERSION = "0.4.1";\n',
		);
		assert.equal(JSON.parse(readFileSync(join(root, "packages/ai/package.json"), "utf8")).version, "1.1.0");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
