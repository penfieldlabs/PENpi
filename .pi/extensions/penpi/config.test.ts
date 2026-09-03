import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMcpLifecycle, resolvePenfieldConfig, resolvePenpiConfig } from "./config.ts";

function clearPenpiEnv() {
	for (const k of Object.keys(process.env)) if (k.startsWith("PENPI_")) delete process.env[k];
}
beforeEach(clearPenpiEnv);
afterEach(clearPenpiEnv);

describe("resolvePenpiConfig", () => {
	it("uses defaults with empty settings", () => {
		expect(resolvePenpiConfig({})).toEqual({
			contextCeiling: 0.75,
			contextFloor: 0.5,
			saveContextOnShutdown: false,
			injectBriefing: true,
			displayBriefing: false,
		});
	});

	it("honors settings.json values", () => {
		expect(resolvePenpiConfig({ contextCeiling: 0.6, contextFloor: 0.4, saveContextOnShutdown: false })).toEqual({
			contextCeiling: 0.6,
			contextFloor: 0.4,
			saveContextOnShutdown: false,
			injectBriefing: true,
			displayBriefing: false,
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

describe("project settings cannot supply credentials", () => {
	const cwd = process.cwd();
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "penpi-cfg-"));
		mkdirSync(join(dir, ".pi"), { recursive: true });
		process.chdir(dir);
	});
	afterEach(() => {
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	});

	function writeProjectSettings(penpi: unknown) {
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ penpi }));
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
		expect(resolvePenfieldConfig().tokenStorePath).not.toContain(dir);
	});

	it("still honors non-credential project settings", () => {
		writeProjectSettings({ contextCeiling: 0.6, contextFloor: 0.3, penfield: { env: "dev" } });
		expect(resolvePenpiConfig().contextCeiling).toBeCloseTo(0.6);
		expect(resolvePenfieldConfig().env).toBe("dev");
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
