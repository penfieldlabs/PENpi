/**
 * H1: a provider that silently keeps only the tail of an oversized request (llama.cpp / Ollama style)
 * and reports the truncated usage. The model declares 64k; the server holds 24k.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { installProviderSim, logger, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const SILENT_LIMIT = 24_000;

describe("H1: silent truncation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const mode of ["a"] as const) {
		it(`h1 mode ${mode}: detects the plateau and stops feeding the truncation`, async () => {
			const stats = newStats();
			const notices: string[] = [];
			const harness = await createHarness({
				models: [{ id: "local-64k", contextWindow: 64_000, maxTokens: 8_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`h1.${ENGINE_LABEL}.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
			const sim = installProviderSim(harness, { silentLimit: SILENT_LIMIT });
			const model = scriptedModel(harness);
			await runPrompts(harness, model, { prompts: 6, turns: 25 });
			const truncated = sim.calls.map((c, i) => (c.truncatedInput ? i : -1)).filter((i) => i >= 0);
			const firstTruncated = truncated[0] ?? -1;
			const lateCalls = sim.calls.slice(firstTruncated + 6);
			report("h1", ENGINE_LABEL, mode, {
				calls: sim.calls.length,
				truncatedRequests: truncated.length,
				droppedMessages: sim.calls.reduce((s, c) => s + c.droppedMessages, 0),
				firstTruncated,
				truncatedAfterDetectionWindow: lateCalls.filter((c) => c.truncatedInput).length,
				maxSentTokens: Math.max(...sim.calls.map((c) => c.promptTokens)),
				ratioSamplesMin: Math.min(...stats.calibrationSamples),
				lastRatioUsed: stats.sent.at(-1)?.ratio,
				cuts: stats.cuts.length,
				warned: notices.filter((n) => /truncat/i.test(n)),
			});
			// At most a short detection lag; afterwards nothing is truncated.
			expect(truncated.length).toBeLessThanOrEqual(4);
			expect(lateCalls.filter((c) => c.truncatedInput)).toHaveLength(0);
			expect(notices.some((n) => /truncat/i.test(n))).toBe(true);
		});
	}
});
