import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import { workspaceSourcePaths } from "../../../../../vitest.base.ts";
import packageConfig from "../../../vitest.config.ts";

// The engine suite's config: the engine imports "@earendil-works/pi-coding-agent", which resolves to the
// source here, as for the harness. The package config excludes this directory from its own run.
const config = mergeConfig(
	packageConfig,
	defineConfig({
		test: {
			include: ["test/suite/context-engine/**/*.test.ts"],
			// D13: deterministic session entry ids in every test.
			setupFiles: ["test/suite/context-engine/deterministic-ids.ts"],
			testTimeout: 300_000,
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
// mergeConfig concatenates arrays: drop the package config's exclusion of this directory.
config.test = { ...config.test, exclude: configDefaults.exclude };
export default config;
