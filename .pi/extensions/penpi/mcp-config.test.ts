import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PenfieldConfig } from "./config.ts";
import { ensurePenfieldMcpEntry, JWT_ENV } from "./mcp-config.ts";

const cfg: PenfieldConfig = {
	env: "dev",
	mcpUrl: "https://mcp-dev.penfield.app/",
	apiBase: "https://api-dev.penfield.app",
	authBase: "https://auth-dev.penfield.app",
	authMode: "apiKey",
	tokenStorePath: "/tmp/x",
	scope: "read write offline_access",
};

function tmpPath() {
	return join(mkdtempSync(join(tmpdir(), "penpi-mcp-")), "mcp.json");
}

describe("ensurePenfieldMcpEntry", () => {
	it("writes a bearer/env penfield entry", () => {
		const path = tmpPath();
		ensurePenfieldMcpEntry(cfg, { path });
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.mcpServers.penfield).toMatchObject({
			url: "https://mcp-dev.penfield.app/",
			auth: "bearer",
			bearerTokenEnv: JWT_ENV,
			directTools: true,
			idleTimeout: 300,
		});
	});

	it("merges without clobbering other servers", () => {
		const path = tmpPath();
		writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "https://x" } }, foo: 1 }));
		ensurePenfieldMcpEntry(cfg, { path });
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.mcpServers.other).toEqual({ url: "https://x" });
		expect(doc.mcpServers.penfield).toBeDefined();
		expect(doc.foo).toBe(1);
	});

	it("passes lifecycle + idleTimeout through", () => {
		const path = tmpPath();
		ensurePenfieldMcpEntry(cfg, { path, lifecycle: "eager", idleTimeout: 30 });
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.mcpServers.penfield.lifecycle).toBe("eager");
		expect(doc.mcpServers.penfield.idleTimeout).toBe(30);
	});

	it("honors PENPI_MCP_CONFIG_PATH when no explicit path (global install)", () => {
		const path = tmpPath();
		const previous = process.env.PENPI_MCP_CONFIG_PATH;
		process.env.PENPI_MCP_CONFIG_PATH = path;
		try {
			const written = ensurePenfieldMcpEntry(cfg);
			expect(written).toBe(path);
			expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.penfield).toBeDefined();
		} finally {
			if (previous === undefined) delete process.env.PENPI_MCP_CONFIG_PATH;
			else process.env.PENPI_MCP_CONFIG_PATH = previous;
		}
	});

	it("defaults to the global agent directory, never the working repository", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "penpi-agent-"));
		const hostileRepo = mkdtempSync(join(tmpdir(), "penpi-hostile-repo-"));
		const tokenTarget = join(hostileRepo, "synthetic-token-store.json");
		const projectMcp = join(hostileRepo, ".pi", "mcp.json");
		writeFileSync(tokenTarget, '{"refresh_token":"synthetic-review-marker"}');
		mkdirSync(join(hostileRepo, ".pi"));
		symlinkSync(tokenTarget, projectMcp);
		const previousCwd = process.cwd();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousMcpPath = process.env.PENPI_MCP_CONFIG_PATH;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PENPI_MCP_CONFIG_PATH;
		process.chdir(hostileRepo);
		try {
			const written = ensurePenfieldMcpEntry(cfg);
			expect(written).toBe(join(agentDir, "mcp.json"));
			expect(JSON.parse(readFileSync(written, "utf8")).mcpServers.penfield).toBeDefined();
			expect(lstatSync(projectMcp).isSymbolicLink()).toBe(true);
			expect(readFileSync(tokenTarget, "utf8")).toBe('{"refresh_token":"synthetic-review-marker"}');
		} finally {
			process.chdir(previousCwd);
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousMcpPath === undefined) delete process.env.PENPI_MCP_CONFIG_PATH;
			else process.env.PENPI_MCP_CONFIG_PATH = previousMcpPath;
		}
	});
});

describe("ensurePenfieldMcpEntry — destructive-write guards", () => {
	const cfg = { mcpUrl: "https://mcp.penfield.app/" } as PenfieldConfig;

	it("refuses to rewrite a file it cannot parse (never silently drops other servers)", () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-mcp-"));
		const path = join(dir, "mcp.json");
		// Hand-edited with a trailing comma, or a torn read from a concurrent session.
		const original = '{\n  "mcpServers": { "duckduckgo": { "command": "npx" }, }\n}';
		writeFileSync(path, original);
		expect(() => ensurePenfieldMcpEntry(cfg, { path })).toThrow(/could not be parsed/);
		expect(readFileSync(path, "utf8")).toBe(original); // untouched
	});

	it("preserves unrelated servers when the file is valid", () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-mcp-"));
		const path = join(dir, "mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { duckduckgo: { command: "npx" } } }));
		ensurePenfieldMcpEntry(cfg, { path });
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.mcpServers.duckduckgo).toBeDefined();
		expect(doc.mcpServers.penfield.bearerTokenEnv).toBe(JWT_ENV);
	});

	it("creates a fresh file when none exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-mcp-"));
		const path = join(dir, "nested", "mcp.json");
		expect(ensurePenfieldMcpEntry(cfg, { path })).toBe(path);
		expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.penfield).toBeDefined();
	});

	it("refuses a symlink without reading or replacing its target", () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-mcp-"));
		const target = join(dir, "synthetic-token-store.json");
		const path = join(dir, "project", ".pi", "mcp.json");
		const original = '{"refresh_token":"synthetic-review-marker","access_token":"synthetic"}';
		writeFileSync(target, original);
		mkdirSync(join(dir, "project", ".pi"), { recursive: true });
		symlinkSync(target, path);
		expect(() => ensurePenfieldMcpEntry(cfg, { path })).toThrow(/symbolic-link MCP config/);
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(original);
	});

	for (const [label, value] of [
		["array root", []],
		["null root", null],
		["array mcpServers", { mcpServers: [] }],
	] as const) {
		it(`refuses ${label} JSON without rewriting`, () => {
			const path = tmpPath();
			const original = JSON.stringify(value);
			writeFileSync(path, original);
			expect(() => ensurePenfieldMcpEntry(cfg, { path })).toThrow(/must be an object/);
			expect(readFileSync(path, "utf8")).toBe(original);
		});
	}
});
