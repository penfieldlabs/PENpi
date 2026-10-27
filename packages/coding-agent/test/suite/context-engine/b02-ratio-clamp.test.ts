/**
 * Behaviours without a test, item 2 (E3.3): the calibration ratio is clamped to [ratioFloor 0.8,
 * ratioCeiling 6]. A provider reporting half the estimate, or ten times it, moves the ratio to the bound.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { installProviderSim, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

describe("E3.3: ratio floor and ceiling", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const [scale, bound] of [
		[0.5, 0.8],
		[10, 6],
	] as const) {
		it(`b02 samples at ${scale}x the estimate clamp the ratio to ${bound}`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "big-1m", contextWindow: 1_000_000, maxTokens: 16_384 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [workExtension, createContextEngine({ stats })],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			installProviderSim(harness, { scale });
			await runPrompts(harness, scriptedModel(harness), { prompts: 2, turns: 6, min: 2_000, spread: 1_000 });
			// The samples themselves are the raw ratio; the ratio used is clamped.
			const sample = stats.calibrationSamples.at(-1) ?? Number.NaN;
			if (bound < 1) expect(sample).toBeLessThan(bound);
			else expect(sample).toBeGreaterThan(bound);
			expect(stats.sent.at(-1)?.ratio).toBe(bound);
		});
	}
});
