import { describe, expect, it } from "vitest";
import { resolveOptions } from "./options.ts";
import { engineOptionsFromSettings, RETIRED_ENV, RETIRED_SETTINGS, retiredEnvWarnings } from "./settings.ts";

function read(settings: Record<string, unknown>) {
	const warnings: string[] = [];
	return { options: engineOptionsFromSettings(settings, (m) => warnings.push(m)), warnings };
}

describe("engine settings (penpi block)", () => {
	it("no settings: no options, so every default applies", () => {
		const { options, warnings } = read({});
		expect(options).toEqual({});
		expect(warnings).toEqual([]);
		expect(resolveOptions(options)).toEqual(resolveOptions({}));
	});

	it("reads the prototype's names and passes valid values through", () => {
		const { options, warnings } = read({
			windowCeiling: 100_000,
			highWater: 0.7,
			maxLengthContinuations: 0,
			notice: true,
			limitOverrides: { "openrouter/z-ai/glm-5.3-flash": { contextWindow: 131_072 } },
			serializeAs: { "faux/x": "openai-completions" },
			replayedReasoning: { "openrouter/z-ai/glm-5.3-flash": "counted" },
			reasoningOnlyContinuation: "continue",
			pinUserMessages: { capFraction: 0.05, sources: ["interactive"] },
			// PENpi's own settings are not engine settings and are left alone.
			penfield: { env: "prod" },
			injectBriefing: true,
		});
		expect(warnings).toEqual([]);
		expect(options).toEqual({
			windowCeiling: 100_000,
			highWater: 0.7,
			maxLengthContinuations: 0,
			notice: true,
			limitOverrides: { "openrouter/z-ai/glm-5.3-flash": { contextWindow: 131_072 } },
			serializeAs: { "faux/x": "openai-completions" },
			replayedReasoning: { "openrouter/z-ai/glm-5.3-flash": "counted" },
			reasoningOnlyContinuation: "continue",
			pinUserMessages: { capFraction: 0.05, sources: ["interactive"] },
		});
	});

	it("0 or null disables the ceiling and null disables the pin", () => {
		expect(read({ windowCeiling: 0 }).options.windowCeiling).toBeNull();
		expect(read({ windowCeiling: null }).options.windowCeiling).toBeNull();
		expect(read({ pinUserMessages: null }).options.pinUserMessages).toBeNull();
	});

	it("ignores a value of the wrong type or range with a warning naming it (ADR 0030: no coercion)", () => {
		const { options, warnings } = read({
			highWater: "0.7",
			lowWater: 1.5,
			notice: "yes",
			replayedReasoning: { "a/b": "maybe" },
			reasoningOnlyContinuation: "skip",
			pinUserMessages: { capFraction: 2, sources: ["email"] },
			limitOverrides: { "a/b": { contextWindow: -1, extra: 1 } },
		});
		expect(options).toEqual({ replayedReasoning: {}, pinUserMessages: {}, limitOverrides: {} });
		for (const name of [
			"penpi.highWater",
			"penpi.lowWater",
			"penpi.notice",
			'penpi.replayedReasoning["a/b"]',
			"penpi.reasoningOnlyContinuation",
			"penpi.pinUserMessages.capFraction",
			"penpi.pinUserMessages.sources",
			'penpi.limitOverrides["a/b"]',
		])
			expect(warnings.some((w) => w.includes(name))).toBe(true);
	});

	it("fault injection is not a setting: penpi.faults and penpi.production are ignored with a warning", () => {
		const { options, warnings } = read({ faults: "overflow=every:2", production: false });
		expect(options).toEqual({});
		expect(warnings.some((w) => w.startsWith("ignoring penpi.faults") && w.includes("PENPI_FAULTS"))).toBe(true);
		expect(warnings.some((w) => w.startsWith("ignoring penpi.production") && w.includes("PENPI_PRODUCTION"))).toBe(
			true,
		);
	});

	it("names PENpi 0.4's FIFO settings as no longer used", () => {
		const { options, warnings } = read({ contextFloor: 0.2, contextCeiling: 0.8, emergencyCompactionRuns: 15 });
		expect(options).toEqual({});
		expect(warnings).toHaveLength(RETIRED_SETTINGS.length);
		for (const name of RETIRED_SETTINGS)
			expect(warnings.some((w) => w.startsWith(`penpi.${name} is no longer used`))).toBe(true);
	});

	it("names PENpi 0.4's FIFO environment variables as no longer used", () => {
		const warnings: string[] = [];
		retiredEnvWarnings(
			{ PENPI_CONTEXT_FLOOR: "0.3", PENPI_CONTEXT_CEILING: "0.9", PENPI_EMERGENCY_COMPACTION_RUNS: "5" },
			(m) => warnings.push(m),
		);
		expect(warnings).toHaveLength(RETIRED_ENV.length);
		for (const name of RETIRED_ENV)
			expect(warnings.some((w) => w.startsWith(`${name} is no longer used`))).toBe(true);
		const none: string[] = [];
		retiredEnvWarnings({ PENPI_ENGINE_LOG: "/tmp/x" }, (m) => none.push(m));
		expect(none).toEqual([]);
	});
});
