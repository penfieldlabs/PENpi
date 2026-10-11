import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpLifecycle, resolvePenfieldConfig, resolvePenpiConfig } from "./config.ts";

function clearPenpiEnv() {
	for (const k of Object.keys(process.env)) if (k.startsWith("PENPI_")) delete process.env[k];
}
beforeEach(clearPenpiEnv);
afterEach(clearPenpiEnv);

describe("resolvePenpiConfig", () => {
	it("uses defaults with empty settings", () => {
		expect(resolvePenpiConfig({})).toEqual({
			contextCeiling: 0.8,
			contextFloor: 0.2,
			saveContextOnShutdown: false,
			injectBriefing: true,
			displayBriefing: false,
			emergencyCompactionRuns: 15,
		});
	});

	it("honors settings.json values", () => {
		expect(resolvePenpiConfig({ contextCeiling: 0.6, contextFloor: 0.4, saveContextOnShutdown: false })).toEqual({
			contextCeiling: 0.6,
			contextFloor: 0.4,
			saveContextOnShutdown: false,
			injectBriefing: true,
			displayBriefing: false,
			emergencyCompactionRuns: 15,
		});
	});

	it("keeps orientation on by default and permits an explicit diagnostic override", () => {
		expect(resolvePenpiConfig({ injectBriefing: false }).injectBriefing).toBe(false);
		process.env.PENPI_INJECT_BRIEFING = "0";
		expect(resolvePenpiConfig({ injectBriefing: true }).injectBriefing).toBe(false);
	});

	it("lets env override settings", () => {
		process.env.PENPI_CONTEXT_CEILING = "0.9";
		expect(resolvePenpiConfig({ contextCeiling: 0.6 }).contextCeiling).toBe(0.9);
	});

	it("resolves emergencyCompactionRuns from settings and env, never below 1", () => {
		expect(resolvePenpiConfig({ emergencyCompactionRuns: 30 }).emergencyCompactionRuns).toBe(30);
		expect(resolvePenpiConfig({ emergencyCompactionRuns: 0 }).emergencyCompactionRuns).toBe(1);
		process.env.PENPI_EMERGENCY_COMPACTION_RUNS = "7.9";
		expect(resolvePenpiConfig({ emergencyCompactionRuns: 30 }).emergencyCompactionRuns).toBe(7);
		process.env.PENPI_EMERGENCY_COMPACTION_RUNS = "abc";
		expect(resolvePenpiConfig({}).emergencyCompactionRuns).toBe(15);
	});

	it("forces floor below ceiling", () => {
		const c = resolvePenpiConfig({ contextCeiling: 0.5, contextFloor: 0.8 });
		expect(c.contextFloor).toBeLessThan(c.contextCeiling);
	});
});

describe("resolvePenfieldConfig", () => {
	it("defaults to prod hosts + deviceCode when no key", () => {
		const c = resolvePenfieldConfig({});
		expect(c.env).toBe("prod");
		expect(c.mcpUrl).toBe("https://mcp.penfield.app/");
		expect(c.authMode).toBe("deviceCode");
	});

	it("switches to -dev hosts for dev env", () => {
		const c = resolvePenfieldConfig({ penfield: { env: "dev" } });
		expect(c.mcpUrl).toBe("https://mcp-dev.penfield.app/");
		expect(c.apiBase).toBe("https://api-dev.penfield.app");
		expect(c.authBase).toBe("https://auth-dev.penfield.app");
	});

	it("uses apiKey mode when a key is configured", () => {
		const c = resolvePenfieldConfig({ penfield: { env: "dev", apiKey: "tm_pf_test" } });
		expect(c.authMode).toBe("apiKey");
		expect(c.apiKey).toBe("tm_pf_test");
	});

	it("lets env override settings env", () => {
		process.env.PENPI_PENFIELD_ENV = "prod";
		expect(resolvePenfieldConfig({ penfield: { env: "dev" } }).env).toBe("prod");
	});

	it("envOverride (the --penpi-dev flag) beats env var and settings", () => {
		process.env.PENPI_PENFIELD_ENV = "prod";
		const c = resolvePenfieldConfig({ penfield: { env: "prod" } }, "dev");
		expect(c.env).toBe("dev");
		expect(c.mcpUrl).toBe("https://mcp-dev.penfield.app/");
	});
});

describe("resolveMcpLifecycle", () => {
	it("returns a valid lifecycle from env", () => {
		process.env.PENPI_MCP_LIFECYCLE = "eager";
		expect(resolveMcpLifecycle({})).toBe("eager");
	});
	it("ignores invalid values", () => {
		process.env.PENPI_MCP_LIFECYCLE = "bogus";
		expect(resolveMcpLifecycle({})).toBeUndefined();
	});
});

describe("penpi settings are global-only", () => {
	const cwd = process.cwd();
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	let project: string;
	let agentDir: string;
	let errors: string[];
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "penpi-cfg-project-"));
		agentDir = mkdtempSync(join(tmpdir(), "penpi-cfg-agent-"));
		mkdirSync(join(project, ".pi"), { recursive: true });
		// Isolate from the developer's real ~/.pi/agent/settings.json.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.chdir(project);
		errors = [];
		errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
	});
	afterEach(() => {
		errorSpy.mockRestore();
		process.chdir(cwd);
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(project, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	function writeProjectSettings(penpi: unknown) {
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ penpi }));
	}
	function writeGlobalSettings(penpi: unknown) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ penpi }));
	}

	it("ignores apiKey/apiKeyFile from a project .pi/settings.json", () => {
		// A hostile repo must not be able to point PENpi at its own Penfield account.
		writeProjectSettings({ penfield: { apiKey: "attacker-key", apiKeyFile: "/etc/passwd" } });
		const cfg = resolvePenfieldConfig();
		expect(cfg.apiKey).toBeUndefined();
		expect(cfg.authMode).toBe("deviceCode");
	});

	it("ignores tokenStore from a project .pi/settings.json", () => {
		// ...nor relocate the refresh token into the repo working tree.
		writeProjectSettings({ penfield: { tokenStore: "./docs/.cache.json" } });
		expect(resolvePenfieldConfig().tokenStorePath).not.toContain(project);
	});

	it("ignores non-credential project settings too", () => {
		// A repo could otherwise switch Penfield environments, disable orientation,
		// reintroduce the eager-lifecycle race, or set a ceiling that prunes every turn.
		writeProjectSettings({
			contextCeiling: 0.02,
			contextFloor: 0.01,
			injectBriefing: false,
			mcpLifecycle: "eager",
			penfield: { env: "dev" },
		});
		expect(resolvePenpiConfig()).toEqual(resolvePenpiConfig({}));
		expect(resolvePenfieldConfig().env).toBe("prod");
		expect(resolveMcpLifecycle()).toBeUndefined();
	});

	it("honors the global settings and ignores a conflicting project block", () => {
		writeGlobalSettings({ contextCeiling: 0.6, penfield: { env: "dev" }, mcpLifecycle: "keep-alive" });
		writeProjectSettings({ contextCeiling: 0.9, penfield: { env: "prod" }, mcpLifecycle: "eager" });
		expect(resolvePenpiConfig().contextCeiling).toBeCloseTo(0.6);
		expect(resolvePenfieldConfig().env).toBe("dev");
		expect(resolveMcpLifecycle()).toBe("keep-alive");
	});

	it("warns when a project penpi block is ignored", () => {
		writeProjectSettings({ contextCeiling: 0.6 });
		resolvePenpiConfig();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(join(project, ".pi", "settings.json"));
		expect(errors[0]).toContain("global-only");
	});

	it("stays quiet when the project settings have no penpi block", () => {
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
		resolvePenpiConfig();
		expect(errors).toEqual([]);
	});

	it("does not mistake the global file for a project file", () => {
		// PI_CODING_AGENT_DIR=<cwd>/.pi makes both paths the same file; that is global.
		process.env.PI_CODING_AGENT_DIR = join(project, ".pi");
		writeProjectSettings({ contextCeiling: 0.6 });
		expect(resolvePenpiConfig().contextCeiling).toBeCloseTo(0.6);
		expect(errors).toEqual([]);
	});
});

describe("displayBriefing", () => {
	it("defaults to false (briefing reaches the model, not the screen)", () => {
		expect(resolvePenpiConfig({}).displayBriefing).toBe(false);
	});

	it("is settable independently of orientation injection", () => {
		expect(resolvePenpiConfig({ displayBriefing: true }).displayBriefing).toBe(true);
		const raw = resolvePenpiConfig({ injectBriefing: false, displayBriefing: true });
		expect(raw.injectBriefing).toBe(false);
		expect(raw.displayBriefing).toBe(true);
	});

	it("honors PENPI_DISPLAY_BRIEFING", () => {
		process.env.PENPI_DISPLAY_BRIEFING = "1";
		expect(resolvePenpiConfig({}).displayBriefing).toBe(true);
		process.env.PENPI_DISPLAY_BRIEFING = "false";
		expect(resolvePenpiConfig({ displayBriefing: true }).displayBriefing).toBe(false);
	});
});

describe("tilde expansion on config paths", () => {
	it("expands a leading ~ in penfield.tokenStore (node fs does not)", () => {
		const cfg = resolvePenfieldConfig({ penfield: { tokenStore: "~/tokens.json" } });
		expect(cfg.tokenStorePath).toBe(`${homedir()}/tokens.json`);
	});

	it("leaves an absolute tokenStore path alone", () => {
		const cfg = resolvePenfieldConfig({ penfield: { tokenStore: "/var/lib/penpi/t.json" } });
		expect(cfg.tokenStorePath).toBe("/var/lib/penpi/t.json");
	});
});

describe("value parsing (briefing item 9)", () => {
	let errors: string[];
	let errorSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		errors = [];
		errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
	});
	afterEach(() => errorSpy.mockRestore());

	it("treats an empty environment variable as unset", () => {
		// `export PENPI_CONTEXT_CEILING=` used to read as 0, then clamp to 0.01: prune on every call.
		for (const k of [
			"PENPI_CONTEXT_CEILING",
			"PENPI_CONTEXT_FLOOR",
			"PENPI_EMERGENCY_COMPACTION_RUNS",
			"PENPI_SAVE_CONTEXT_ON_SHUTDOWN",
			"PENPI_INJECT_BRIEFING",
			"PENPI_DISPLAY_BRIEFING",
		]) {
			process.env[k] = " ";
		}
		const settings = {
			contextCeiling: 0.6,
			contextFloor: 0.3,
			emergencyCompactionRuns: 30,
			saveContextOnShutdown: true,
			injectBriefing: false,
			displayBriefing: true,
		};
		expect(resolvePenpiConfig(settings)).toEqual(settings);
		expect(errors).toEqual([]);
	});

	it("uses only finite numbers, from either source", () => {
		const bad = { contextCeiling: "0.6", contextFloor: Number.NaN, emergencyCompactionRuns: "abc" } as never;
		expect(resolvePenpiConfig(bad)).toEqual(resolvePenpiConfig({}));
		process.env.PENPI_CONTEXT_CEILING = "Infinity";
		process.env.PENPI_EMERGENCY_COMPACTION_RUNS = "12abc";
		const c = resolvePenpiConfig({ contextCeiling: 0.6, emergencyCompactionRuns: 30 });
		expect(c.contextCeiling).toBe(0.6);
		expect(c.emergencyCompactionRuns).toBe(30);
		for (const v of Object.values(resolvePenpiConfig(bad)))
			if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
	});

	it("rejects a ceiling or floor above 1 instead of clamping it", () => {
		// 75 meant 75%; clamping it to 0.99 would let the window fill completely.
		process.env.PENPI_CONTEXT_CEILING = "75";
		const fromEnv = resolvePenpiConfig({ contextCeiling: 0.6 });
		expect(fromEnv.contextCeiling).toBe(0.6);
		const fromSettings = resolvePenpiConfig({ contextFloor: 50 });
		expect(fromSettings.contextFloor).toBe(resolvePenpiConfig({}).contextFloor);
		expect(errors.some((e) => e.includes("PENPI_CONTEXT_CEILING") && e.includes("75"))).toBe(true);
		expect(errors.some((e) => e.includes("contextFloor") && e.includes("50"))).toBe(true);
	});

	it("still accepts 1 and clamps it, as before", () => {
		expect(resolvePenpiConfig({ contextCeiling: 1 }).contextCeiling).toBe(0.99);
		expect(errors).toEqual([]);
	});

	it("reports an unparseable value by name", () => {
		process.env.PENPI_CONTEXT_FLOOR = "half";
		resolvePenpiConfig({});
		expect(errors).toEqual([expect.stringContaining("PENPI_CONTEXT_FLOOR")]);
	});

	it("ignores a non-boolean setting where a boolean is expected and warns", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// "false" is a truthy string: read as-is it would turn the checkpoint ON.
			const c = resolvePenpiConfig({ saveContextOnShutdown: "false", injectBriefing: "no" } as never);
			expect(c.saveContextOnShutdown).toBe(false);
			expect(c.injectBriefing).toBe(true);
			// Both should produce a warning (F-3).
			const warnings = spy.mock.calls.map((c) => c[0] as string).filter((m) => m.includes("not a boolean"));
			expect(warnings).toHaveLength(2);
			expect(warnings[0]).toContain("saveContextOnShutdown");
			expect(warnings[1]).toContain("injectBriefing");
		} finally {
			spy.mockRestore();
		}
	});
});
