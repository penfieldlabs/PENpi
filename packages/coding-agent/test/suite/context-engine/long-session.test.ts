/**
 * E1/E2/E3: a 500-turn synthetic session with tool calls, run once per window mechanism.
 * Writes a JSON report per mode to .cache/out/long-session.<mode>.json.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, type EngineMode, NOTICE_MARKER, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	countEntries,
	finalTurn,
	LOG_DIR,
	logger,
	rng,
	scriptedModel,
	toolTurn,
	validateRequest,
	workExtension,
} from "./helpers.ts";

const WINDOW = 32_000;
const MAX_TOKENS = 4_000;

async function runLongSession(mode: EngineMode) {
	const stats = newStats();
	const log = logger(`long-session.${mode}.log`);
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: MAX_TOKENS }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [workExtension, createContextEngine({ mode, stats, log })],
	});
	await harness.session.bindExtensions({});
	const model = scriptedModel(harness);
	const next = rng(42);
	const plan: Array<{ prompt: string; turns: number }> = [
		...Array.from({ length: 20 }, (_, i) => ({ prompt: `Task ${i}: process batch ${i}.`, turns: 20 })),
		{ prompt: "Task 20: one long agentic run without user messages.", turns: 100 },
	];
	const usageBeforePrompt: Array<{ estimate: number | null; firstRequestTokens: number }> = [];
	let seed = 0;
	const started = performance.now();
	for (const { prompt, turns } of plan) {
		for (let t = 0; t < turns - 1; t++) model.push(toolTurn(300 + Math.floor(next() * 5_700), seed++));
		model.push(finalTurn(`Done with: ${prompt}`));
		const usage = harness.session.getContextUsage();
		const before = model.promptTokens.length;
		await harness.session.prompt(prompt);
		usageBeforePrompt.push({ estimate: usage?.tokens ?? null, firstRequestTokens: model.promptTokens[before] ?? -1 });
	}
	const elapsedMs = performance.now() - started;
	// The P4 pre-cut notice is request-only (never persisted), so the next request cannot contain it.
	const isNotice = (m: string) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER);
	const prefix = analyzePrefixes(model.requests, isNotice);
	const prefixRaw = analyzePrefixes(model.requests);
	const entries = harness.sessionManager.getEntries();
	const sessionBytes = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 0);
	const finalUsage = harness.session.getContextUsage();
	const projectionMessages = harness.sessionManager.buildSessionProjection().messages.length;
	const report = {
		mode,
		assistantTurns: model.cursor,
		requests: model.requests.length,
		maxPromptTokens: Math.max(...model.promptTokens),
		window: WINDOW,
		cuts: stats.cuts.length,
		structuralViolations: model.requests.flatMap((r, i) => validateRequest(r).map((p) => `${i}: ${p}`)).slice(0, 10),
		guardTrims: stats.guardTrims,
		alignMismatches: stats.alignMismatches,
		prefix,
		prefixRaw: { breaks: prefixRaw.breaks, idealPrefixShare: prefixRaw.idealPrefixShare },
		notices: model.requests.filter((r) => r.some(isNotice)).length,
		compactionStartEvents: harness.eventsOfType("compaction_start").length,
		entryCounts: countEntries(harness),
		sessionBytes,
		projectionMessages,
		finalUsage,
		usageBeforePrompt,
		calibration: {
			samples: stats.calibrationSamples.length,
			last: stats.calibrationSamples.at(-1),
			min: Math.min(...stats.calibrationSamples),
			max: Math.max(...stats.calibrationSamples),
		},
		elapsedMs: Math.round(elapsedMs),
		fauxCalls: harness.faux.state.callCount,
		cutsDetail: stats.cuts.slice(0, 5),
	};
	writeFileSync(`${LOG_DIR}/long-session.${mode}.json`, JSON.stringify(report, null, 2));
	return { harness, report, stats };
}

describe("context engine: 500-turn session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const mode of ["a"] as const) {
		it(`mode ${mode}: never compacts, never exceeds the window`, async () => {
			const { harness, report } = await runLongSession(mode);
			harnesses.push(harness);
			expect(report.assistantTurns).toBe(500);
			expect(report.requests).toBe(500);
			expect(report.fauxCalls).toBe(500); // no hidden summarization request
			expect(report.compactionStartEvents).toBe(0);
			expect(report.maxPromptTokens).toBeLessThanOrEqual(WINDOW);
			expect(report.alignMismatches).toBe(0);
			expect(report.structuralViolations).toEqual([]);
			// Prefix changes only at cuts.
			expect(report.prefix.breaks).toBeLessThanOrEqual(report.cuts);
			expect(report.guardTrims).toBe(0);
		});
	}
});
