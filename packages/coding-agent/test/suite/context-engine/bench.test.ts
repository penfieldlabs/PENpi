/**
 * Scaling benchmark (opt-in: CONTEXT_ENGINE_BENCH=1): wall time per block of 100 requests as the session grows,
 * per window mechanism. Writes .cache/out/bench.json.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";
import { createContextEngine, type EngineMode, newStats } from "./engine.ts";
import { finalTurn, LOG_DIR, rng, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const results: Record<string, unknown> = {};
const TURNS = Number(process.env.CONTEXT_ENGINE_BENCH_TURNS ?? 2000);

describe.runIf(process.env.CONTEXT_ENGINE_BENCH === "1")("context engine: scaling", () => {
	for (const mode of ["a"] as EngineMode[]) {
		it(`mode ${mode}: ${TURNS} turns`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [workExtension, createContextEngine({ mode, stats })],
			});
			await harness.session.bindExtensions({});
			const model = scriptedModel(harness, TURNS + 10);
			const next = rng(123);
			const blocks: number[] = [];
			let seed = 0;
			let blockStart = performance.now();
			for (let p = 0; p < TURNS / 20; p++) {
				for (let t = 0; t < 19; t++) model.push(toolTurn(300 + Math.floor(next() * 5_700), seed++));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`Task ${p}`);
				if (((p + 1) * 20) % 100 === 0) {
					blocks.push(Math.round(performance.now() - blockStart));
					blockStart = performance.now();
				}
			}
			const entries = harness.sessionManager.getEntries();
			results[mode] = {
				msPer100Requests: blocks,
				first5: blocks.slice(0, 5),
				last5: blocks.slice(-5),
				cuts: stats.cuts.length,
				handlerMsLast100: Math.round(stats.handlerMs.slice(-100).reduce((a, b) => a + b, 0)),
				sessionMB: entries.reduce((s, e) => s + JSON.stringify(e).length + 1, 0) / 1e6,
				projectionMessages: harness.sessionManager.buildSessionProjection().messages.length,
			};
			writeFileSync(`${LOG_DIR}/bench.json`, JSON.stringify(results, null, 2));
			harness.cleanup();
			expect(model.cursor).toBe(TURNS);
		});
	}
});
