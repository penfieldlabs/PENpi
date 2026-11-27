import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../../vitest.base.ts";

const schema = (path: string) => fileURLToPath(new URL(`../../../packages/schema/src/${path}`, import.meta.url));

// The extension's tests load Pi from source, as the engine suite does, so they need no build: vitest.base.ts's
// aliases (pi-ai and the other packages), and pi-coding-agent's and pi-schema's, which it lacks. pi-mcp-adapter is
// inlined, so its own imports of Pi take the aliases too; left external, Node would resolve them to the packages'
// built dist/, a second pi-ai. check:penpi still type-checks against the built types, and CI's engine-on-upstream job
// tests built packages.
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: { server: { deps: { inline: [/pi-mcp-adapter/] } } },
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{ find: /^@earendil-works\/pi-schema$/, replacement: schema("index.ts") },
				{ find: /^@earendil-works\/pi-schema\/formats$/, replacement: schema("formats/index.ts") },
			],
		},
	}),
);
