import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");
const aiPackage = JSON.parse(readFileSync(join(repo, "packages", "ai", "package.json"), "utf8"));
const dataDir = join(repo, "packages", "ai", "src", "providers", "data");

test("ordinary AI builds use the committed model snapshot without network refresh", () => {
	assert.equal(aiPackage.scripts.build, "npm run build:offline");
	assert.match(aiPackage.scripts["build:offline"], /check:model-data/);
	assert.doesNotMatch(aiPackage.scripts.build, /generate-models|hydrate/);

	const files = readdirSync(dataDir);
	assert.ok(files.includes(".manifest.json"));
	assert.ok(files.filter((file) => file.endsWith(".json")).length > 1);

	const ignore = readFileSync(join(repo, ".gitignore"), "utf8");
	assert.doesNotMatch(ignore, /^packages\/ai\/src\/providers\/data\/?$/m);
});
