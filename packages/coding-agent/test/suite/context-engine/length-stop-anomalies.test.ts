/**
 * R5 fix (E4 glm-full B/s02, 2026-10-14): an answer cut at the output limit with reasoning only is
 * replayed without content, and GLM-5.3-Flash via OpenRouter counted none of its reasoning. The r5
 * detector read "16,234 tokens appended, reported usage +27" as silent truncation and shrank a 200k
 * window to 21k. The patched engine leaves such reasoning out of the appended estimate and does not
 * judge the sample right after a length stop.
 *
 * P3: the detector leaves all replayed reasoning out. P4: one strong judged sample acts (two weak ones do);
 * an honest anomaly's window, far below 25% of the planning window, is re-probed and retired.
 *
 * The provider here counts honestly, except that (like the GLM upstream) it counts nothing of a
 * replayed assistant message with reasoning only. Optionally it truncates silently, or drops
 * one appended result once (a single anomaly).
 */

import type { Context as TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	type ProviderSim,
	report,
	type ScriptItem,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const MODEL = { id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 };

/** An answer that hit the output limit while still reasoning: thinking only, stopReason "length". */
function lengthStopReasoningOnly(chars: number): ScriptItem {
	return () =>
		fauxAssistantMessage(
			[
				fauxThinking(
					`Let me count by hand. ${"order.shipped eu-west; ".repeat(Math.ceil(chars / 23))}`.slice(0, chars),
				),
			],
			{ stopReason: "length" },
		);
}

function reasoningOnly(message: TranscriptContext["messages"][number]): boolean {
	if (message.role !== "assistant") return false;
	return !message.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text.trim().length > 0));
}

/**
 * Wraps the provider sim so it sees what the GLM upstream counted: reasoning-only assistant messages
 * count as empty. `dropOnce(call)` may remove the last tool result's text from what is counted for one
 * call (a single honest-provider anomaly).
 */
function glmLikeProvider(
	harness: Harness,
	options: { silentLimit?: number; silentFromCall?: number; dropOnceAtCall?: number } = {},
): { sim: ProviderSim; callIndex: () => number } {
	const silent =
		options.silentLimit === undefined
			? undefined
			: { silentLimit: options.silentLimit, silentReport: "limit" as const };
	const sim = installProviderSim(harness, silent ?? {});
	const agent = harness.session.agent;
	const inner = agent.streamFunction;
	let calls = 0;
	agent.streamFunction = (model, context, streamOptions) => {
		const index = calls++;
		let messages = context.messages.map((m) => (reasoningOnly(m) ? ({ ...m, content: [] } as typeof m) : m));
		if (index === options.dropOnceAtCall) {
			const last = messages.findLastIndex((m) => m.role === "toolResult");
			if (last >= 0)
				messages = messages.map((m, i) => (i === last ? ({ ...m, content: [fauxText("")] } as typeof m) : m));
		}
		return inner(model, { ...context, messages }, streamOptions);
	};
	return { sim, callIndex: () => calls };
}

describe("length stops and single anomalies", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const stats = newStats();
		const lines: string[] = [];
		// Provider calls recorded when the engine logged "silent truncation:" (set once the sim exists).
		const ref: { sim?: ProviderSim; detectedAtCall?: number } = {};
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					stats,
					log: (line) => {
						lines.push(line);
						// At message_end of call k the simulator has recorded k + 1 calls.
						if (ref.detectedAtCall === undefined && line.includes("silent truncation:"))
							ref.detectedAtCall = ref.sim?.calls.length;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { stats, lines, harness, ref };
	}

	async function warmUp(harness: Harness, model: ReturnType<typeof scriptedModel>, prompts: number, seed: number) {
		for (let p = 0; p < prompts; p++) {
			for (let t = 0; t < 6; t++) model.push(toolTurn(6_000 + ((seed + t) % 5) * 2_000, seed + p * 10 + t));
			model.push(finalTurn(`summary ${p}`));
			await harness.session.prompt(`Look at part ${p}.`);
		}
	}

	it("a reasoning-only length stop is not silent truncation (honest provider, 200k window unchanged)", async () => {
		const { stats, lines, harness } = await setup();
		glmLikeProvider(harness);
		const model = scriptedModel(harness);
		await warmUp(harness, model, 3, 100);
		// About 17k tokens of reasoning, cut at the limit; the engine continues; the answer follows.
		model.push(lengthStopReasoningOnly(70_000), finalTurn("The most common type is order.shipped."));
		await harness.session.prompt("Which event type is most common?");
		await warmUp(harness, model, 2, 200);
		const evidence = lines.filter((l) => l.includes("silent truncation"));
		report("length-stop-anomalies", ENGINE_LABEL, "honest", {
			evidence,
			plateaus: stats.plateaus,
			cuts: stats.cuts.length,
		});
		expect(stats.lengthContinuations).toBeGreaterThanOrEqual(1);
		expect(lines.some((l) => l.includes("silent truncation:"))).toBe(false);
		expect(stats.plateaus).toHaveLength(0);
		expect(lines.some((l) => l.includes("the next usage sample is not judged for truncation"))).toBe(true);
	});

	it("truncation that starts after a length stop is still detected within 3 truncated requests", async () => {
		const { stats, lines, harness, ref } = await setup();
		// The server holds 60k: the warm-up stays below, the growth after the length stop goes above.
		const { sim } = glmLikeProvider(harness, { silentLimit: 60_000 });
		ref.sim = sim;
		const model = scriptedModel(harness);
		await warmUp(harness, model, 2, 300);
		model.push(lengthStopReasoningOnly(70_000), finalTurn("The most common type is order.shipped."));
		await harness.session.prompt("Which event type is most common?");
		expect(sim.calls.filter((c) => c.truncatedInput)).toHaveLength(0);
		for (let p = 0; p < 4 && ref.detectedAtCall === undefined; p++) await warmUp(harness, model, 1, 400 + p * 20);
		const truncated = sim.calls.flatMap((c, i) => (c.truncatedInput ? [i] : []));
		const lag = ref.detectedAtCall === undefined ? null : truncated.filter((i) => i < ref.detectedAtCall!).length;
		report("length-stop-anomalies", ENGINE_LABEL, "truncation-after-length-stop", {
			truncatedAt: truncated,
			detectedAtCall: ref.detectedAtCall,
			lag,
			evidence: lines.filter((l) => l.includes("silent truncation")),
			plateaus: stats.plateaus,
		});
		expect(truncated.length).toBeGreaterThan(0);
		expect(stats.plateaus).toHaveLength(1);
		expect(stats.plateaus[0].window).toBeLessThanOrEqual(60_000);
		// The r5 bar (silent-detector.test.ts): detection within 3 truncated requests.
		expect(lag).not.toBeNull();
		expect(lag!).toBeLessThanOrEqual(3);
	});

	it("a single strong anomaly mid-session on an honest provider is learned at once, then re-probed and retired", async () => {
		// p4 acts on one strong sample (r5, p1 and p2 did; p3's confirmation rule was slower against real
		// truncation, E2 C5/C6). The cost of an honest anomaly is bounded instead: the window learned from it is
		// far below 25% of the planning window, so it is re-probed (D12: requests at 0.3 of the window count toward
		// the re-probe; at half the window, p3's rule, none did here) and the honest report retires it.
		const { stats, lines, harness } = await setup();
		// Call 11 (in the second prompt's tool loop) does not count the tool result just appended.
		glmLikeProvider(harness, { dropOnceAtCall: 11 });
		const model = scriptedModel(harness);
		await warmUp(harness, model, 10, 500);
		const strong = lines.filter((l) => l.includes("(strong)"));
		report("length-stop-anomalies", ENGINE_LABEL, "single-anomaly", {
			evidence: lines.filter((l) => l.includes("silent truncation") || l.includes("probe")),
			plateaus: stats.plateaus,
			probes: stats.probes,
		});
		expect(strong).toHaveLength(1);
		expect(lines.some((l) => l.includes("the next usage sample is not judged for truncation"))).toBe(false);
		expect(stats.plateaus).toHaveLength(1);
		expect(stats.plateaus[0].window).toBeLessThan(0.25 * MODEL.contextWindow);
		expect(lines.some((l) => l.includes("(learned window retired)"))).toBe(true);
		expect(stats.lastLimits?.window).toBe(MODEL.contextWindow);
	});
});
