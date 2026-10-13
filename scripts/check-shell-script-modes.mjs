#!/usr/bin/env node
// Every shell script that the workflows, README, installer or npm scripts invoke by path
// must be executable in git. A script committed without +x passes review and only fails
// when a release runs `./scripts/<name>.sh`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const SCRIPT_PATH = /(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.sh)\b/g;

export function referencedScripts(text) {
	const found = new Set();
	for (const match of text.matchAll(SCRIPT_PATH)) {
		found.add(posix.normalize(match[1]));
	}
	return found;
}

export function sourceFiles(repoRoot) {
	const workflowsDir = join(repoRoot, ".github", "workflows");
	const workflows = readdirSync(workflowsDir)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.map((name) => join(".github", "workflows", name));
	return [...workflows, "README.md", "scripts/penpi-global.sh", "package.json"];
}

export function indexModes(repoRoot) {
	const output = execFileSync("git", ["ls-files", "-s", "--", "*.sh"], { cwd: repoRoot, encoding: "utf8" });
	const modes = new Map();
	for (const line of output.split("\n")) {
		const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(line);
		if (match) modes.set(match[2], match[1]);
	}
	return modes;
}

export function findNonExecutable(repoRoot) {
	const modes = indexModes(repoRoot);
	const problems = [];
	for (const source of sourceFiles(repoRoot)) {
		const text = readFileSync(join(repoRoot, source), "utf8");
		for (const script of referencedScripts(text)) {
			const mode = modes.get(script);
			if (mode === undefined) continue; // not a tracked script (example path, external tool)
			if (mode !== "100755") problems.push({ script, source, mode });
		}
	}
	return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const repoRoot = resolve(import.meta.dirname, "..");
	const problems = findNonExecutable(repoRoot);
	if (problems.length > 0) {
		for (const { script, source, mode } of problems) {
			console.error(`${script} is mode ${mode} in git but is invoked from ${source}`);
		}
		console.error("Fix with: git update-index --chmod=+x <script>");
		process.exit(1);
	}
	console.log("Invoked shell scripts are executable.");
}
