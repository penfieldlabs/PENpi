/**
 * H3: learned windows are evidence, not facts. One bad route (an OpenRouter endpoint with a 16k
 * limit, hit once) must not shrink a 64k model for the rest of the session; a genuinely smaller limit
 * must hold with a bounded number of extra rejections.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { installProviderSim, logger, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const openRouter = (tokens: number, limit: number) =>
	`This endpoint's maximum context length is ${limit} tokens. However, you requested about ${tokens} tokens (${tokens - 500} of text input, 500 in the output). Please reduce the length of either one.`;

describe("H3: learned window expiry and re-probe", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const mode of ["a"] as const) {
		it(`h3 mode ${mode}: one bad route does not shrink the window for good`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "router-64k", contextWindow: 64_000, maxTokens: 8_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`h3.${ENGINE_LABEL}.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			let badRouteUsed = false;
			const sim = installProviderSim(harness, {
				realLimit: (_i, tokens) => {
					if (!badRouteUsed && tokens > 16_384) {
						badRouteUsed = true;
						return 16_384;
					}
					return 64_000;
				},
				overflowMessage: openRouter,
			});
			const model = scriptedModel(harness);
			await runPrompts(harness, model, { prompts: 12, turns: 25 });
			const rejected = sim.calls.filter((c) => c.rejected).length;
			const last60 = sim.calls.slice(-60).filter((c) => !c.rejected);
			const maxLate = Math.max(...last60.map((c) => c.promptTokens));
			report("h3", ENGINE_LABEL, `bad-route.${mode}`, {
				calls: sim.calls.length,
				rejected,
				maxLast60: maxLate,
				turns: model.cursor,
			});
			expect(model.cursor).toBe(300);
			expect(rejected).toBeLessThanOrEqual(2);
			expect(maxLate).toBeGreaterThan(30_000);
		});

		it(`h3 mode ${mode}: a genuinely smaller limit holds with bounded probing`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "router-64k", contextWindow: 64_000, maxTokens: 8_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`h3.${ENGINE_LABEL}.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { realLimit: 20_000 });
			const model = scriptedModel(harness);
			await runPrompts(harness, model, { prompts: 12, turns: 25 });
			const rejected = sim.calls.filter((c) => c.rejected).length;
			const accepted = sim.calls.filter((c) => !c.rejected);
			report("h3", ENGINE_LABEL, `smaller-limit.${mode}`, {
				calls: sim.calls.length,
				rejected,
				rejectedAt: sim.calls.map((c, i) => (c.rejected ? i : -1)).filter((i) => i >= 0),
				maxAccepted: Math.max(...accepted.map((c) => c.promptTokens)),
				turns: model.cursor,
			});
			expect(model.cursor).toBe(300);
			expect(rejected).toBeLessThanOrEqual(4);
		});
	}
});
