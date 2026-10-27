/**
 * E6: length continuation at turn_end, and whether upstream's recoverable-length path (compact and
 * retry) pre-empts it.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { CONTINUE_TYPE, createContextEngine, newStats } from "./engine.ts";
import { finalTurn, LOG_DIR, logger, scriptedModel } from "./helpers.ts";

const results: Record<string, unknown> = {};
const MAX_TOKENS = 1_000;

async function run(options: { enabled: boolean; continuations: number; atMax: boolean }) {
	const stats = newStats();
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: MAX_TOKENS }],
		settings: { compaction: { enabled: options.enabled } },
		extensionFactories: [
			// Cases with the setting on document Pi's own paths, so the P5 refusal is relaxed to a warning.
			createContextEngine({
				stats,
				maxLengthContinuations: options.continuations,
				onCompactionEnabled: "warn",
				log: logger("length.log"),
			}),
		],
	});
	await harness.session.bindExtensions({});
	const model = scriptedModel(harness);
	// Some history so Pi's own compaction would have something to summarize.
	for (let i = 0; i < 3; i++) {
		model.push(finalTurn(`history answer ${i} ${"h".repeat(30_000)}`));
		await harness.session.prompt(`history ${i} ${"q".repeat(30_000)}`);
	}
	// faux usage.output = chars / 4: 400 chars = 100 tokens (below max), 4000+ chars = at max.
	const truncated = options.atMax ? "x".repeat(MAX_TOKENS * 4 + 40) : "The answer begins like this and then";
	model.push(finalTurn(truncated, "length"), finalTurn("...and here is the rest."));
	const before = model.requests.length;
	await harness.session.prompt("Write the long answer.");
	const after = model.requests.slice(before);
	const lastRequest = after.at(-1) ?? [];
	return {
		harness,
		stats,
		report: {
			requestsForPrompt: after.length,
			continuationSent: lastRequest.some((m) => m.includes("reached the output token limit")),
			truncatedTextInContext: lastRequest.some((m) => m.includes(truncated.slice(0, 30))),
			compactionStart: harness.eventsOfType("compaction_start").map((e) => e.reason),
			cancelled: stats.cancelledCompactions,
			lengthContinuations: stats.lengthContinuations,
			omissions: harness.sessionManager.getEntries().filter((e) => e.type === "context_edit").length,
			continueEntries: harness.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === CONTINUE_TYPE).length,
		},
	};
}

describe("context engine: length continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/length.json`, JSON.stringify(results, null, 2));
	});

	for (const atMax of [false, true]) {
		const label = atMax ? "at maxTokens" : "below maxTokens";
		it(`continues a length stop ${label} with compaction disabled`, async () => {
			const { harness, report } = await run({ enabled: false, continuations: 3, atMax });
			harnesses.push(harness);
			results[`${label}.enabled=false`] = report;
			expect(report.requestsForPrompt).toBe(2);
			expect(report.continuationSent).toBe(true);
			expect(report.truncatedTextInContext).toBe(true);
			expect(report.compactionStart).toEqual([]);
		});

		it(`with compaction enabled, the in-run continuation still runs first (${label})`, async () => {
			const { harness, report } = await run({ enabled: true, continuations: 3, atMax });
			harnesses.push(harness);
			results[`${label}.enabled=true`] = report;
			expect(report.continuationSent).toBe(true);
		});

		it(`with compaction enabled and no continuation budget, upstream recovery takes over (${label})`, async () => {
			const { harness, report } = await run({ enabled: true, continuations: 0, atMax });
			harnesses.push(harness);
			results[`${label}.enabled=true.budget=0`] = report;
		});
	}
});
