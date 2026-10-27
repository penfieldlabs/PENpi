/**
 * D3 (port): an option given as undefined keeps its default.
 *   `{ ...DEFAULTS, ...overrides }` copied undefined over a default, so a config loader that maps a missing
 *   key to undefined silently switched off the pin (pinUserMessages) and the 200k ceiling (windowCeiling).
 *   Defaults are now merged ignoring undefined; only null (or 0 where documented) switches a feature off.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, type EngineOptions, newStats, PIN_DEFAULTS, resolveOptions } from "./engine.ts";
import { runPrompts, scriptedModel, workExtension } from "./helpers.ts";

describe("D3: undefined options keep their defaults", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d3 every option set to undefined resolves to the defaults", () => {
		const defaults = resolveOptions({});
		const allUndefined = Object.fromEntries(
			Object.keys(defaults).map((key) => [key, undefined]),
		) as Partial<EngineOptions>;
		expect(Object.keys(defaults).length).toBeGreaterThan(40);
		expect(resolveOptions(allUndefined)).toEqual(defaults);
		expect(resolveOptions(allUndefined).windowCeiling).toBe(200_000);
		expect(resolveOptions(allUndefined).pinUserMessages).toEqual(PIN_DEFAULTS);
		// A partial pin object with undefined fields is completed from PIN_DEFAULTS.
		const pinUndefined = Object.fromEntries(Object.keys(PIN_DEFAULTS).map((key) => [key, undefined]));
		expect(resolveOptions({ pinUserMessages: pinUndefined }).pinUserMessages).toEqual(PIN_DEFAULTS);
		// null still switches a feature off.
		expect(resolveOptions({ pinUserMessages: null, windowCeiling: null })).toMatchObject({
			pinUserMessages: null,
			windowCeiling: null,
		});
	});

	it("d3 with every option undefined, a 1M model still plans within 200k and pins after a cut", async () => {
		const stats = newStats();
		const options = Object.fromEntries(
			Object.keys(resolveOptions({})).map((key) => [key, undefined]),
		) as Partial<EngineOptions>;
		const harness = await createHarness({
			models: [{ id: "glm-1m", contextWindow: 1_000_000, maxTokens: 16_384 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ ...options, stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);
		await runPrompts(harness, model, { prompts: 6, turns: 12, min: 8_000, spread: 12_000 });
		expect(stats.lastLimits?.window).toBe(200_000);
		expect(stats.cuts.length).toBeGreaterThan(0);
		expect(stats.pinTokens.at(-1)).toBeGreaterThan(0);
	});
});
