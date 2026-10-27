/**
 * Behaviours without a test, item 6: G1's one-shot output cap is not consumed by a cache-warming request.
 * After an output-caused combined error ("input + max_tokens > context"), the engine caps the retry's
 * output at the room the provider stated. Pi's cache warmer replays the last request through the same
 * payload hook with max_tokens 1; such a request asks for less than the cap and leaves it for the retry.
 * The cap matters where the durable bounds do not hold: with calibration off and a provider that counts
 * more than the estimate, the learned context alone would still let the retry ask too much.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { ERROR_FIXTURES } from "./g1-error-fixtures.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "g1-model", contextWindow: 200_000, maxTokens: 943_717 };
const CONTEXT = 30_500;

describe("G1: the one-shot cap and cache warming", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const fixture = ERROR_FIXTURES.find((f) => f.render && f.expected.class === "combined-output-caused")!;

	it(`b06 a cache-warming request between the error and the retry leaves the cap for the retry (${fixture.id})`, async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false }, retry: { baseDelayMs: 1, maxRetries: 2 } },
			extensionFactories: [workExtension, createContextEngine({ stats, calibrate: false })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness, {
			scale: 1.25,
			// The provider's real context is 30,500: input + output above it is rejected (the input alone fits).
			reject: ({ maxTokens, promptTokens }) =>
				maxTokens !== 1 && promptTokens + (maxTokens ?? 0) > CONTEXT
					? fixture.render!({
							requested: maxTokens ?? 0,
							limit: 0,
							input: promptTokens,
							context: CONTEXT,
							model: MODEL.id,
						})
					: undefined,
		});
		// Like CacheWarmer.refresh: before the retry, replay the last request with maxTokens 1 (same options, so
		// the same payload hook).
		const agent = harness.session.agent;
		const inner = agent.streamFunction;
		let warmed = 0;
		agent.streamFunction = async (model, context, options) => {
			if (sim.calls.at(-1)?.rejected && warmed === 0) {
				warmed++;
				await (await inner(model, context, { ...options, maxTokens: 1, maxRetries: 0 })).result();
			}
			return inner(model, context, options);
		};
		const model = scriptedModel(harness);
		model.push(toolTurn(80_000, 1), finalTurn("done"));
		await harness.session.prompt("Read the big file.");

		const rejected = sim.calls.findIndex((c) => c.rejected);
		expect(rejected).toBeGreaterThanOrEqual(0);
		const warm = sim.calls[rejected + 1];
		const retry = sim.calls[rejected + 2];
		expect(warmed).toBe(1);
		expect(warm.maxTokens).toBe(1);
		// The retry carries the cap: it fits the provider's context and is accepted.
		expect(retry.rejected).toBe(false);
		expect(retry.promptTokens + (retry.maxTokens ?? 0)).toBeLessThanOrEqual(CONTEXT);
		expect(sim.calls.filter((c) => c.rejected)).toHaveLength(1);
	});
});
