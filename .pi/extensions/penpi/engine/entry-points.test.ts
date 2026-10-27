/**
 * engine-only.ts (the release-gate benchmark's entry point) and the full extension build the context engine
 * with identical resolved options: the same settings, read the same way, with the same defaults. Only the
 * wiring differs (the full extension routes /penpi doctor from its own command).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineWiring } from "./index.ts";
import { type EngineOptions, resolveOptions } from "./options.ts";

const built: Array<{ options: EngineOptions; wiring: EngineWiring }> = [];
vi.mock("./index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./index.ts")>();
	return {
		...actual,
		createContextEngine: (overrides: Partial<EngineOptions> = {}, wiring: EngineWiring = {}) => {
			built.push({ options: resolveOptions(overrides), wiring });
			return actual.createContextEngine(overrides, wiring);
		},
	};
});

function fakePi() {
	const commands: string[] = [];
	return {
		commands,
		pi: {
			on: () => {},
			registerTool: () => {},
			registerCommand: (name: string) => commands.push(name),
			registerFlag: () => {},
			getActiveTools: () => [],
			getSettings: () => ({ compaction: { enabled: false } }),
		},
	};
}

describe("entry points", () => {
	let agentDir: string;
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousLog = process.env.PENPI_ENGINE_LOG;
	beforeEach(() => {
		built.length = 0;
		// A log path in the shell must not reach the engines built here (nor get a file written).
		delete process.env.PENPI_ENGINE_LOG;
		agentDir = mkdtempSync(join(tmpdir(), "penpi-entry-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// Engine settings in the global settings: both entry points must see them.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ penpi: { windowCeiling: 100_000, pinUserMessages: { capFraction: 0.05 }, notice: false } }),
		);
	});
	afterEach(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousLog !== undefined) process.env.PENPI_ENGINE_LOG = previousLog;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("engine-only.ts and the full extension build the engine with identical resolved options", async () => {
		const { default: engineOnly } = await import("../engine-only.ts");
		const { defaultDeps } = await import("../index.ts");
		const bench = fakePi();
		engineOnly(bench.pi as never);
		const full = fakePi();
		const installEngine = defaultDeps().installEngine;
		expect(installEngine).toBeTypeOf("function");
		installEngine?.(full.pi as never);

		expect(built).toHaveLength(2);
		const [benchBuild, fullBuild] = built;
		// The settings reached both.
		expect(benchBuild.options.windowCeiling).toBe(100_000);
		expect((benchBuild.options.pinUserMessages as { capFraction: number }).capFraction).toBe(0.05);
		// Identical resolved options (every engine setting and default).
		expect(fullBuild.options).toEqual(benchBuild.options);
		// Wiring only: the benchmark's entry point registers /penpi; the full extension routes from its own.
		expect(benchBuild.wiring.registerCommand).toBe(true);
		expect(fullBuild.wiring.registerCommand).toBe(false);
		expect(bench.commands).toEqual(["penpi"]);
		expect(full.commands).toEqual([]);
	}, 60_000);
});
