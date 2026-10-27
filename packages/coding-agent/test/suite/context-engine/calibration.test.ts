/**
 * E3: learn the estimate-to-provider ratio from the request actually sent. The provider simulator
 * counts 1.7x the faux tokens (a tokenizer the chars/4 estimate undercounts) and rejects anything
 * above the real window.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, parseOverflow } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	LOG_DIR,
	logger,
	rng,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const results: Record<string, unknown> = {};
const WINDOW = 32_000;

describe("context engine: calibration", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/calibration.json`, JSON.stringify(results, null, 2));
	});

	it("parses limits and request sizes from provider overflow errors", () => {
		expect(parseOverflow("prompt is too long: 213462 tokens > 200000 maximum")).toEqual({
			limit: 200000,
			requested: 213462,
		});
		expect(
			parseOverflow(
				"This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens",
			),
		).toEqual({
			limit: 131072,
			requested: 140000,
		});
		expect(
			parseOverflow("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"),
		).toEqual({
			limit: 1048575,
			requested: 1196265,
		});
		expect(parseOverflow("Your input exceeds the context window of this model")).toEqual({
			limit: undefined,
			requested: undefined,
		});
	});

	for (const mode of ["a"] as const) {
		for (const calibrate of [true, false]) {
			it(`mode ${mode}, calibrate=${calibrate}: provider counts 1.7x the estimate`, async () => {
				const stats = newStats();
				const harness = await createHarness({
					models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: 4_000 }],
					settings: { compaction: { enabled: false } },
					extensionFactories: [
						workExtension,
						createContextEngine({ mode, stats, calibrate, log: logger(`calibration.${mode}.${calibrate}.log`) }),
					],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				const sim = installProviderSim(harness, { scale: 1.7, realLimit: WINDOW });
				const model = scriptedModel(harness);
				const next = rng(11);
				let seed = 0;
				for (let p = 0; p < 5; p++) {
					for (let t = 0; t < 19; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), seed++));
					model.push(finalTurn(`done ${p}`));
					await harness.session.prompt(`Task ${p}`);
				}
				const accepted = sim.calls.filter((c) => !c.rejected);
				const later = accepted.slice(Math.floor(accepted.length / 2));
				results[`${mode}.calibrate=${calibrate}`] = {
					assistantTurns: model.cursor,
					calls: sim.calls.length,
					rejected: sim.calls.filter((c) => c.rejected).length,
					overflowRetries: stats.overflowRetries,
					maxAcceptedProviderTokens: Math.max(...accepted.map((c) => c.promptTokens)),
					meanUtilizationSecondHalf: later.reduce((a, c) => a + c.promptTokens, 0) / later.length / WINDOW,
					cuts: stats.cuts.length,
					lastSamples: stats.calibrationSamples.slice(-3),
				};
				expect(model.cursor).toBe(100);
				if (calibrate) expect(sim.calls.filter((c) => c.rejected)).toHaveLength(0);
			});
		}
	}
});
