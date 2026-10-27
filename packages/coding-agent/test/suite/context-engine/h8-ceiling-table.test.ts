/**
 * H8 tuning table (opt-in: CONTEXT_ENGINE_CEILING_TABLE=1). For 1M-window models at ceilings of 100k, 200k,
 * 400k and none: the band, average and maximum request size over a 500-turn session, cuts, and the
 * ideal-prefix share. Writes .cache/out/reports/h8-table.<engine>.json.
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, NOTICE_MARKER, newStats } from "./engine.ts";
import { analyzePrefixes, installProviderSim, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const MODELS = [
	{ id: "glm-1m", contextWindow: 1_048_575, maxTokens: 943_717 },
	{ id: "gemini-like-1m", contextWindow: 1_048_576, maxTokens: 65_536 },
];
const CEILINGS: Array<number | null> = [100_000, 200_000, 400_000, null];

describe.runIf(process.env.CONTEXT_ENGINE_CEILING_TABLE === "1")("H8: ceiling tuning table", () => {
	for (const definition of MODELS) {
		for (const windowCeiling of CEILINGS) {
			it(`h8-table ${definition.id} ceiling ${windowCeiling ?? "none"}`, async () => {
				const stats = newStats();
				const harness = await createHarness({
					models: [definition],
					settings: { compaction: { enabled: false } },
					extensionFactories: [workExtension, createContextEngine({ stats, windowCeiling })],
				});
				await harness.session.bindExtensions({});
				const sim = installProviderSim(harness);
				const model = scriptedModel(harness, 600, { digest: true });
				const started = performance.now();
				// 500 assistant turns, tool results of 4k-24k characters (about 3.5k tokens a turn, 1.75M in total).
				await runPrompts(harness, model, { prompts: 25, turns: 20, min: 4_000, spread: 20_000 });
				const sizes = sim.calls.map((c) => c.promptTokens);
				const prefix = analyzePrefixes(
					model.requests,
					(m) => m.endsWith("#notice") || (NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER)),
				);
				const limits = stats.lastLimits;
				const row = {
					model: `${definition.id} (${definition.contextWindow}/${definition.maxTokens})`,
					ceiling: windowCeiling ?? "none",
					window: limits?.window,
					reason: limits?.reason,
					reserve: limits?.reserve,
					budget: limits?.budget,
					bandHigh: Math.round(limits?.high ?? 0),
					bandLow: Math.round(limits?.low ?? 0),
					requests: sizes.length,
					avgRequest: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
					maxRequest: Math.max(...sizes),
					lastRequest: sizes.at(-1),
					overBand: sizes.filter((s) => s > (limits?.high ?? Infinity)).length,
					cuts: stats.cuts.length,
					idealPrefixShare: +prefix.idealPrefixShare.toFixed(3),
					prefixBreaks: prefix.breaks,
					seconds: Math.round((performance.now() - started) / 1000),
				};
				report("h8-table", ENGINE_LABEL, `${definition.id}.${windowCeiling ?? "none"}`, row);
				harness.cleanup();
				expect(model.cursor).toBe(500);
			});
		}
	}
});
