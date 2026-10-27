/**
 * H2: calibration is per model. Two models of very different token density share one session; the
 * provider counts 2.0x the faux tokens for "dense" and 0.8x for "sparse" and rejects anything above
 * 32,000 tokens for both.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { installProviderSim, logger, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const WINDOW = 32_000;
const HIGH_WATER_PROVIDER = 0.75 * (WINDOW - 4_000);

describe("H2: per-model calibration", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const mode of ["a"] as const) {
		it(`h2 mode ${mode}: switching between a dense and a sparse model`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [
					{ id: "dense", contextWindow: WINDOW, maxTokens: 4_000 },
					{ id: "sparse", contextWindow: WINDOW, maxTokens: 4_000 },
				],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`h2.${ENGINE_LABEL}.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { scale: (m) => (m.id === "dense" ? 2.0 : 0.8), realLimit: WINDOW });
			const model = scriptedModel(harness);
			const phases: Array<{ model: string; from: number; to: number }> = [];
			let seedBase = 0;
			for (const id of ["dense", "sparse", "dense", "sparse"]) {
				await harness.session.setModel(harness.getModel(id)!);
				const from = sim.calls.length;
				await runPrompts(harness, model, { prompts: 3, turns: 20, seed: seedBase + 1, seedBase });
				seedBase += 1000;
				phases.push({ model: id, from, to: sim.calls.length });
			}
			const summary = phases.map((phase) => {
				const calls = sim.calls.slice(phase.from, phase.to);
				const accepted = calls.filter((c) => !c.rejected);
				return {
					model: phase.model,
					calls: calls.length,
					rejected: calls.filter((c) => c.rejected).length,
					maxFirst10: Math.max(...calls.slice(0, 10).map((c) => c.promptTokens)),
					maxAccepted: Math.max(...accepted.map((c) => c.promptTokens)),
				};
			});
			report("h2", ENGINE_LABEL, mode, { summary, overflowRetries: stats.overflowRetries, turns: model.cursor });
			expect(model.cursor).toBe(240);
			for (const phase of summary) {
				expect(phase.rejected).toBe(0);
				// No overshoot after a switch: the first requests stay under high water (10% slack).
				expect(phase.maxFirst10).toBeLessThanOrEqual(HIGH_WATER_PROVIDER * 1.1);
			}
		});
	}
});
