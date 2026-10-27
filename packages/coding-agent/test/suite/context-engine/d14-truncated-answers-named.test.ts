/**
 * D14 (port): every answer produced from truncated input is named.
 *   A server that drops whole old messages and reports what it kept can look clean: when the message it
 *   drops is smaller than the append, reported usage still grows by most of the append. Such a request is
 *   neither a quarantined sample, nor an exact repeat, nor (once later requests report more) at the
 *   maximum, so p4 did not name it. Once the window is learned, a recent sample expected above it by more
 *   than plateauFlatness cannot have been processed whole, and is named too.
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, report, scriptedModel, syntheticText, workExtension } from "./helpers.ts";

const MODEL = { id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 };
/** The server's real context: 30% of the planning window, so the learned window is never re-probed. */
const LIMIT = 60_000;

describe("D14: answers from truncated input", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d14 names a truncated request whose usage grew by about its append (drop-whole-messages server)", async () => {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness, { silentLimit: LIMIT, silentReport: "remainder" });
		const model = scriptedModel(harness, 200);
		// Each answer picks the next tool result's size from the request it answers (provider tokens, chars / 4):
		//   grow by 8,000 until a request is 5,000 to 13,000 below the limit; then one result that overshoots the
		//   limit by about 2,000, so the server drops only the 4,000-token first prompt (usage grows by at least 43%
		//   of the append: clean); then three 700-token results (the maximum moves more than 2% past the first
		//   truncated request); then 8,000 again, which drops a whole result (strong evidence: detection).
		let phase: "grow" | "overshoot" | "small" | "drop" = "grow";
		let small = 0;
		const step = (n: number) => () => {
			const tokens = sim.calls.at(-1)?.promptTokens ?? 0;
			let size = 8_000;
			if (phase === "grow" && tokens + 8_000 >= LIMIT - 5_000) phase = "overshoot";
			else if (phase === "overshoot") phase = "small";
			else if (phase === "small" && ++small > 3) phase = "drop";
			if (phase === "overshoot") size = LIMIT + 2_000 - tokens;
			else if (phase === "small") size = 700;
			return fauxAssistantMessage(
				[fauxText(`Step ${n}.`), fauxToolCall("work", { size: size * 4, seed: n }, { id: `call-${n}` })],
				{
					stopReason: "toolUse",
				},
			);
		};
		for (let n = 0; n < 16; n++) model.push(step(n));
		model.push(finalTurn("done"));
		await harness.session.prompt(`First task: ${syntheticText(16_000, 3).replace(/\s+/g, " ")}`);

		expect(sim.calls.some((c) => c.rejected)).toBe(false);
		// One answer per call: call i answered turn i + 1.
		const truncated = sim.calls.flatMap((c, i) => (c.truncatedInput ? [i + 1] : []));
		const named = stats.plateauReports.flatMap((r) => r.turns.map((t) => t.turn ?? 0)).sort((a, b) => a - b);
		report("d14", ENGINE_LABEL, "drop-whole-messages", {
			truncated,
			named,
			dropped: sim.calls.map((c) => c.droppedMessages),
			reported: sim.calls.map((c) => c.processedTokens),
			sent: sim.calls.map((c) => c.promptTokens),
			plateaus: stats.plateaus,
		});
		// The premise: the first truncated request dropped only the first prompt and looked clean.
		const first = sim.calls.findIndex((c) => c.truncatedInput);
		expect(sim.calls[first].droppedMessages).toBe(1);
		// And it lies outside the rule before D14 ("at the maximum": within plateauFlatness, 2%, of the largest
		// usage reported at detection), so only D14's rule can name it; if the fixture drifts, this fails first.
		// The window learned at detection is that largest usage (below the model's window).
		const maxAtDetection = stats.plateaus[0].window;
		expect(maxAtDetection).toBe(Math.max(...sim.calls.map((c) => c.processedTokens)));
		expect(sim.calls[first].processedTokens).toBeLessThan(0.98 * maxAtDetection);
		expect(lines.filter((l) => l.includes("silent truncation evidence")).length).toBeGreaterThan(0);
		expect(stats.plateaus).toHaveLength(1);
		expect(truncated.length).toBeGreaterThanOrEqual(3);
		expect(named).toEqual(truncated);
	});
});
