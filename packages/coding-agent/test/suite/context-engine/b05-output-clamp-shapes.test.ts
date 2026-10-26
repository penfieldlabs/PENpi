/**
 * Behaviours without a test, item 5 (E7.4): the output clamp only ever lowers, in all 7 payload shapes it
 * knows (max_tokens, max_completion_tokens, max_output_tokens, maxTokens, maxOutputTokens,
 * generationConfig.maxOutputTokens, inferenceConfig.maxTokens). Above the allowed output it is lowered; a
 * value below it is left alone, and so is a cache-warming request's max_tokens: 1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel } from "./helpers.ts";

const SHAPES: Array<[string] | [string, string]> = [
	["max_tokens"],
	["max_completion_tokens"],
	["max_output_tokens"],
	["maxTokens"],
	["maxOutputTokens"],
	["generationConfig", "maxOutputTokens"],
	["inferenceConfig", "maxTokens"],
];
const MAX_OUTPUT = 4_000;

describe("E7.4: the output clamp", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const shape of SHAPES) {
		it(`b05 ${shape.join(".")}: lowered above the allowed output, never raised; max_tokens 1 untouched`, async () => {
			const stats = newStats();
			const asked = { value: 0 };
			// Registered before the engine: rewrites the synthetic payload into this shape.
			const shaper = (pi: ExtensionAPI) => {
				pi.on("before_provider_request", (event) => {
					const { max_tokens: _drop, ...rest } = event.payload as Record<string, unknown>;
					if (shape.length === 1) return { ...rest, [shape[0]]: asked.value };
					return { ...rest, [shape[0]]: { [shape[1]]: asked.value, other: "kept" } };
				});
			};
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: MAX_OUTPUT }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [shaper, createContextEngine({ stats })],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, {});
			const model = scriptedModel(harness);
			const read = (payload: Record<string, unknown>) =>
				shape.length === 1 ? payload[shape[0]] : (payload[shape[0]] as Record<string, unknown>)[shape[1]];
			const sent: unknown[] = [];
			for (const value of [50_000, 100, 1]) {
				asked.value = value;
				model.push(finalTurn(`answer ${value}`));
				await harness.session.prompt(`Ask for ${value}.`);
				const payload = sim.calls.at(-1)!.payload;
				sent.push(read(payload));
				if (shape.length === 2) expect((payload[shape[0]] as Record<string, unknown>).other).toBe("kept");
			}
			expect(sent[0]).toBeLessThanOrEqual(MAX_OUTPUT);
			expect(sent[0]).toBeGreaterThan(100);
			expect(sent[1]).toBe(100);
			expect(sent[2]).toBe(1);
			expect(stats.clampedOutput).toBe(1);
		});
	}
});
