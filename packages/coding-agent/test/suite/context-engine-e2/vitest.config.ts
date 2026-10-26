import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import { workspaceSourcePaths } from "../../../../../vitest.base.ts";
import packageConfig from "../../../vitest.config.ts";

// E2 config, modelled on test/suite/context-engine/vitest.config.ts: the engine under test imports
// "@earendil-works/pi-coding-agent" from source (the package is not built in this worktree). No upstream
// file is modified. Temp files (harness dirs) and Vite's cache go under this directory's git-ignored .cache/scratch. Each matrix file
// runs its sessions one after another; files run in parallel on E2_WORKERS workers (default 2).
const scratch = process.env.E2_SCRATCH ?? fileURLToPath(new URL("./.cache/scratch", import.meta.url));
mkdirSync(`${scratch}/tmp`, { recursive: true });

const config = mergeConfig(
	packageConfig,
	defineConfig({
		cacheDir: `${scratch}/vite-cache`,
		test: {
			// *.e2.ts, so the package's default run (npm test) does not pick up the matrix.
			include: ["test/suite/context-engine-e2/**/*.e2.ts"],
			// Deterministic session entry ids (the header and cap notices name them), reset per run (runner.ts).
			setupFiles: ["test/suite/context-engine/deterministic-ids.ts"],
			testTimeout: 3_600_000,
			hookTimeout: 600_000,
			reporters: ["default"],
			silent: false,
			maxWorkers: Number(process.env.E2_WORKERS ?? 2),
			env: { TMPDIR: `${scratch}/tmp` },
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
// mergeConfig concatenates arrays; keep only the default reporter (the package config adds "dot").
config.test = {
	...config.test,
	exclude: configDefaults.exclude,
	reporters: process.env.GITHUB_ACTIONS ? ["default", "github-actions"] : ["default"],
};
export default config;
