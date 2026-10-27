/**
 * Behaviours without a test, item 8: the silent-truncation detector fires and warns again after
 * /penpi reset-limits. A server that truncates at 60k is detected (window learned, warning shown); the
 * reset forgets the learned window, the engine sends above 60k again, and a second detection warns again.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { installProviderSim, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

describe("detection after reset-limits", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("b08 truncate, detect, reset, truncate again: a second warning", async () => {
		const stats = newStats();
		const notices: string[] = [];
		const harness = await createHarness({
			models: [{ id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
		// 30% of the planning window: never re-probed, so only the reset lifts the learned window.
		const sim = installProviderSim(harness, { silentLimit: 60_000, silentReport: "limit" });
		const model = scriptedModel(harness, 6_000);
		const warnings = () => notices.filter((n) => n.includes("silently truncated its input"));
		await runPrompts(harness, model, { prompts: 4, turns: 10, min: 7_000, spread: 2_000, seedBase: 1 });
		expect(stats.plateaus).toHaveLength(1);
		expect(warnings()).toHaveLength(1);
		expect(stats.lastLimits?.window).toBeLessThanOrEqual(60_000);

		await harness.session.prompt("/penpi reset-limits");
		expect(stats.limitResets).toBe(1);
		const truncatedBefore = sim.calls.filter((c) => c.truncatedInput).length;
		await runPrompts(harness, model, { prompts: 4, turns: 10, min: 7_000, spread: 2_000, seedBase: 100 });
		// The engine planned against the full window again, the server truncated again, and it was detected again.
		expect(sim.calls.filter((c) => c.truncatedInput).length).toBeGreaterThan(truncatedBefore);
		expect(stats.plateaus).toHaveLength(2);
		expect(warnings()).toHaveLength(2);
		expect(stats.lastLimits?.window).toBeLessThanOrEqual(60_000);
	});
});
