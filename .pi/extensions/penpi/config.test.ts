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
			saveContextOnShutdown: false,
			injectBriefing: true,
			displayBriefing: false,
		});
	});

	it("honors settings.json values", () => {
		expect(resolvePenpiConfig({ saveContextOnShutdown: true, displayBriefing: true })).toEqual({
			saveContextOnShutdown: true,
			injectBriefing: true,
			displayBriefing: true,
		});
	});

	it("keeps orientation on by default and permits an explicit diagnostic override", () => {
		expect(resolvePenpiConfig({ injectBriefing: false }).injectBriefing).toBe(false);
		process.env.PENPI_INJECT_BRIEFING = "0";
		expect(resolvePenpiConfig({ injectBriefing: true }).injectBriefing).toBe(false);
	});

	it("lets env override settings", () => {
		process.env.PENPI_SAVE_CONTEXT_ON_SHUTDOWN = "1";
		expect(resolvePenpiConfig({ saveContextOnShutdown: false }).saveContextOnShutdown).toBe(true);
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
		// reintroduce the eager-lifecycle race, or shrink the context engine's window.
		writeProjectSettings({
			windowCeiling: 1_000,
			injectBriefing: false,
			mcpLifecycle: "eager",
			penfield: { env: "dev" },
		});
		expect(resolvePenpiConfig()).toEqual(resolvePenpiConfig({}));
		expect(resolvePenfieldConfig().env).toBe("prod");
		expect(resolveMcpLifecycle()).toBeUndefined();
	});

	it("honors the global settings and ignores a conflicting project block", () => {
		writeGlobalSettings({ displayBriefing: true, penfield: { env: "dev" }, mcpLifecycle: "keep-alive" });
		writeProjectSettings({ displayBriefing: false, penfield: { env: "prod" }, mcpLifecycle: "eager" });
		expect(resolvePenpiConfig().displayBriefing).toBe(true);
		expect(resolvePenfieldConfig().env).toBe("dev");
		expect(resolveMcpLifecycle()).toBe("keep-alive");
	});

	it("warns when a project penpi block is ignored", () => {
		writeProjectSettings({ displayBriefing: true });
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
		writeProjectSettings({ displayBriefing: true });
		expect(resolvePenpiConfig().displayBriefing).toBe(true);
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
		// `export PENPI_SAVE_CONTEXT_ON_SHUTDOWN=` must not override the setting.
		for (const k of ["PENPI_SAVE_CONTEXT_ON_SHUTDOWN", "PENPI_INJECT_BRIEFING", "PENPI_DISPLAY_BRIEFING"]) {
			process.env[k] = " ";
		}
		const settings = {
			saveContextOnShutdown: true,
			injectBriefing: false,
			displayBriefing: true,
		};
		expect(resolvePenpiConfig(settings)).toEqual(settings);
		expect(errors).toEqual([]);
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
