#!/usr/bin/env node

/**
 * Asserts that built release archives actually contain PENpi.
 *
 * `scripts/build-binaries.sh` is inherited from upstream Pi. It compiles
 * `packages/coding-agent` and copies Pi's metadata, docs and native assets — it
 * has never copied `.pi/extensions/penpi`. The published v0.2.0 Linux asset was
 * inspected and identifies itself as `@earendil-works/pi-coding-agent@0.83.0`
 * with no PENpi extension present.
 *
 * So the release attaches Pi binaries under a PENpi tag. A user who downloads
 * one gets upstream Pi and none of the memory management they came for, with
 * nothing in the artifact to tell them so.
 *
 * This check makes that fail loudly at release time instead of shipping. It does
 * not fix the packaging — building a real PENpi distribution is a separate piece
 * of work — it refuses to publish an artifact that misrepresents itself.
 *
 * Usage: node scripts/check-release-assets.mjs <dir-of-extracted-platform-builds>
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root || !existsSync(root)) {
	console.error("usage: node scripts/check-release-assets.mjs <output-dir>");
	process.exit(2);
}

const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const platforms = readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());

if (platforms.length === 0) {
	console.error(`No platform directories found under ${root}`);
	process.exit(1);
}

const failures = [];
for (const platform of platforms) {
	const dir = join(root, platform);

	// 1. The extension must be present at all.
	if (!existsSync(join(dir, ".pi", "extensions", "penpi", "index.ts"))) {
		failures.push(`${platform}: .pi/extensions/penpi is absent — this is upstream Pi, not PENpi`);
	}

	// 2. The bundled manifest must identify PENpi at the release version, not
	//    @earendil-works/pi-coding-agent at its own.
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		failures.push(`${platform}: no package.json in the archive`);
		continue;
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.version !== expectedVersion) {
		failures.push(`${platform}: archive declares version ${manifest.version}, release is ${expectedVersion}`);
	}
	if (!String(manifest.name).toLowerCase().includes("penpi")) {
		failures.push(`${platform}: archive identifies as "${manifest.name}", which is not PENpi`);
	}
}

if (failures.length > 0) {
	console.error("Release assets do not contain PENpi:\n");
	for (const f of failures) console.error(`  ${f}`);
	console.error("\nDo not publish these archives. Either build a real PENpi distribution");
	console.error("(extension + installer + docs), or stop attaching binaries to PENpi releases.");
	process.exit(1);
}

console.log(`All ${platforms.length} platform archives contain PENpi ${expectedVersion}.`);
