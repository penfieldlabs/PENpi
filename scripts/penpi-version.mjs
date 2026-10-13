// PENpi's release version and every file it lives in. The upstream workspace packages
// (packages/*) keep upstream Pi's version; bumping them would produce an upstream
// version and tag name (for example v1.1.1 from packages/ai at 1.1.0).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PENPI_MANIFESTS = ["package.json", ".pi/extensions/penpi/package.json"];
export const PENPI_HANDSHAKE = ".pi/extensions/penpi/penfield-client.ts";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HANDSHAKE_RE = /export const PENPI_VERSION = "([^"]+)";/;

export function getPenpiVersion(repoRoot = process.cwd()) {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

export function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The version a release target resolves to: a bump type, or an explicit x.y.z above the current one. */
export function nextVersion(current, target) {
	const [major, minor, patch] = current.split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	if (target === "patch") return `${major}.${minor}.${patch + 1}`;
	if (!SEMVER_RE.test(target)) throw new Error(`invalid release target: ${target}`);
	if (compareVersions(target, current) <= 0) {
		throw new Error(`explicit version ${target} must be greater than current version ${current}`);
	}
	return target;
}

/** Write `version` to every PENpi version surface except the lockfile (refresh that with npm). */
export function setPenpiVersion(version, repoRoot = process.cwd()) {
	if (!SEMVER_RE.test(version)) throw new Error(`invalid version: ${version}`);
	for (const manifest of PENPI_MANIFESTS) {
		const path = join(repoRoot, manifest);
		const text = readFileSync(path, "utf8");
		const pkg = JSON.parse(text);
		// Replace the field in place so the rest of the file keeps its formatting.
		const updated = text.replace(`"version": "${pkg.version}"`, `"version": "${version}"`);
		if (JSON.parse(updated).version !== version) throw new Error(`could not update the version in ${manifest}`);
		writeFileSync(path, updated);
	}
	const handshakePath = join(repoRoot, PENPI_HANDSHAKE);
	const handshake = readFileSync(handshakePath, "utf8");
	if (!HANDSHAKE_RE.test(handshake)) throw new Error(`could not find PENPI_VERSION in ${PENPI_HANDSHAKE}`);
	writeFileSync(handshakePath, handshake.replace(HANDSHAKE_RE, `export const PENPI_VERSION = "${version}";`));
}
