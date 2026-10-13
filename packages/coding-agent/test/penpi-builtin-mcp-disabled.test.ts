/**
 * PENpi disables Pi's built-in MCP extension (`-builtin:mcp`) in the global settings it writes.
 *
 * The built-in reads the same global mcp.json where PENpi writes its `penfield` entry. It is
 * replaceable, so it normally steps aside when PENpi's embedded pi-mcp-adapter registers `/mcp`;
 * if the embedded adapter fails to load, it would run instead and serve that entry outside
 * PENpi. With the setting the installer writes, it must not load even then.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePenfieldMcpEntry, JWT_ENV } from "../../../.pi/extensions/penpi/mcp-config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const settingsEditor = join(repoRoot, "scripts", "penpi-settings.mjs");

describe("PENpi global settings disable the built-in MCP extension", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let savedJwt: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "penpi-builtin-mcp-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		savedJwt = process.env[JWT_ENV];
		process.env[JWT_ENV] = "penfield-jwt-under-test";
	});
	afterEach(() => {
		if (savedJwt === undefined) delete process.env[JWT_ENV];
		else process.env[JWT_ENV] = savedJwt;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not load the built-in MCP extension when the embedded adapter fails to load", async () => {
		const settingsPath = join(agentDir, "settings.json");
		execFileSync(process.execPath, [settingsEditor, "install", settingsPath]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).extensions).toEqual(["-builtin:mcp"]);
		// The penfield entry PENpi writes for its embedded adapter, with the JWT in the environment.
		ensurePenfieldMcpEntry({ mcpUrl: "https://mcp.penfield.test/mcp" } as never, {
			path: join(agentDir, "mcp.json"),
		});

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [
				...builtInExtensions,
				{
					name: "penpi-embedded-adapter",
					factory: () => {
						throw new Error("embedded pi-mcp-adapter failed to load");
					},
				},
			],
		});
		await loader.reload();

		const paths = loader.getExtensions().extensions.map((extension) => extension.path);
		expect(paths).not.toContain("builtin:mcp");
		expect(loader.getExtensions().errors.map((error) => error.error)).toEqual([
			expect.stringContaining("embedded pi-mcp-adapter failed to load"),
		]);
	});

	it("keeps entries the user already has in extensions", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ extensions: ["~/my-ext.ts", "-builtin:llama.cpp"] }));
		execFileSync(process.execPath, [settingsEditor, "install", settingsPath]);
		execFileSync(process.execPath, [settingsEditor, "install", settingsPath]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).extensions).toEqual([
			"~/my-ext.ts",
			"-builtin:llama.cpp",
			"-builtin:mcp",
		]);

		execFileSync(process.execPath, [settingsEditor, "uninstall", settingsPath]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).extensions).toEqual(["~/my-ext.ts", "-builtin:llama.cpp"]);
	});
});
