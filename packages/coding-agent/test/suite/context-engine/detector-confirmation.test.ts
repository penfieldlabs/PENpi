/**
 * P3 (B3, B4; reviewer Change 2): confirmation among judged samples, and bounded re-probes.
 *   - P4: one strong judged sample acts at once; two weak judged samples within the evidence span act.
 *     Unjudged samples (small appends, the sample after a length stop, warm-up after a model switch) are
 *     skipped and do not reset the count. A clean sample above the running maximum clears weak evidence.
 *   - A silent-learned window below 25% of the planning window is re-probed on the H3 schedule
 *     (probeAfterUnparsed clean requests near it), at most twice per session; G2 names truncated probe
 *     answers. At or above 25% it is never re-probed (E3.10).
 * The usage the provider reports is scripted per call on top of the honest provider simulator.
 */

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	type ProviderSim,
	report,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const MODEL = { id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 };

/**
 * Outermost wrapper: `usage(call, honest, previous)` returns what the provider reports for call `call`
 * (honest = the simulator's count, previous = what was reported for the call before); undefined = honest.
 */
function scriptUsage(
	harness: Harness,
	usage: (call: number, honest: number, previous: number) => number | undefined,
): { reported: number[] } {
	const out = { reported: [] as number[] };
	const agent = harness.session.agent;
	const inner = agent.streamFunction;
	agent.streamFunction = async (model, context, options) => {
		const call = out.reported.length;
		out.reported.push(0);
		const source = await inner(model, context, options);
		const stream = createAssistantMessageEventStream();
		(async () => {
			for await (const event of source) {
				if (event.type === "done") {
					const honest = event.message.usage.input;
					const value = usage(call, honest, call > 0 ? out.reported[call - 1] : 0) ?? honest;
					out.reported[call] = value;
					const message: AssistantMessage = {
						...event.message,
						usage: { ...event.message.usage, input: value, totalTokens: value + event.message.usage.output },
					};
					stream.push({ ...event, message });
					stream.end(message);
					return;
				}
				if (event.type === "error") {
					stream.push(event);
					stream.end(event.error);
					return;
				}
				stream.push(event);
			}
		})();
		return stream;
	};
	return out;
}

describe("detector confirmation and re-probes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(sim: Parameters<typeof installProviderSim>[1] = {}) {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const provider: ProviderSim = installProviderSim(harness, sim);
		return { stats, lines, harness, provider, model: scriptedModel(harness, 6_000) };
	}

	/** One prompt of tool turns with the given result sizes (characters), then a final answer. */
	async function turns(h: Awaited<ReturnType<typeof setup>>, sizes: number[], seed: number) {
		for (const [i, size] of sizes.entries()) h.model.push(toolTurn(size, seed + i));
		h.model.push(finalTurn(`done ${seed}`));
		await h.harness.session.prompt(`Process batch ${seed} and report.`);
	}

	const evidence = (lines: string[]) => lines.filter((l) => l.includes("silent truncation"));

	it("one strong sample acts at once: the window is learned from it", async () => {
		const h = await setup();
		// Call 8 reports no growth after a full tool result: strong evidence, acted on immediately.
		scriptUsage(h.harness, (call, _honest, previous) => (call === 8 ? previous : undefined));
		await turns(
			h,
			Array.from({ length: 14 }, () => 8_000),
			100,
		);
		const ev = evidence(h.lines);
		report("detector-confirmation", ENGINE_LABEL, "strong-acts", ev);
		expect(ev[0]).toContain("evidence 1/2 (strong)");
		expect(h.lines.some((l) => l.includes("silent truncation:"))).toBe(true);
		expect(h.stats.plateaus).toHaveLength(1);
	});

	/** Weak evidence: growth of a fifth of the honest growth (below 25%, above the 15% strong line). */
	const weak = (honest: number, previous: number) => previous + Math.round(0.2 * (honest - previous));

	it("two weak samples act; an unjudged sample between them does not reset the count", async () => {
		const h = await setup();
		// Call 8 weak (the running maximum stays at call 7's report); call 9 appends a tiny result (unjudged) and
		// reports 50 under that maximum, as a truncating server can; call 10 grows by a fifth of its honest growth.
		const honestAt: number[] = [];
		const reportedAt: number[] = [];
		scriptUsage(h.harness, (call, honest, previous) => {
			honestAt[call] = honest;
			let value: number | undefined;
			if (call === 8) value = weak(honest, previous);
			else if (call === 9) value = reportedAt[7] - 50;
			else if (call === 10) value = previous + Math.round(0.2 * (honest - honestAt[9]));
			reportedAt[call] = value ?? honest;
			return value;
		});
		const sizes = Array.from({ length: 14 }, (_, i) => (i === 8 ? 10 : 8_000));
		await turns(h, sizes, 200);
		const ev = evidence(h.lines);
		report("detector-confirmation", ENGINE_LABEL, "weak-unjudged-between", ev);
		expect(ev[0]).toContain("evidence 1/2");
		expect(ev[0]).not.toContain("(strong)");
		expect(ev[1]).toContain("evidence 2/2");
		expect(ev.some((l) => l.includes("evidence cleared"))).toBe(false);
		expect(h.lines.some((l) => l.includes("silent truncation:"))).toBe(true);
		expect(h.stats.plateaus).toHaveLength(1);
	});

	it("a clean sample above the running maximum between two weak samples clears the evidence: no detection", async () => {
		const h = await setup();
		// Call 9 appends a normal result and reports honestly (above the running maximum): evidence cleared.
		scriptUsage(h.harness, (call, honest, previous) =>
			call === 8 || call === 10 ? weak(honest, previous) : undefined,
		);
		await turns(
			h,
			Array.from({ length: 14 }, () => 8_000),
			300,
		);
		const ev = evidence(h.lines);
		report("detector-confirmation", ENGINE_LABEL, "weak-clean-between", ev);
		expect(ev.filter((l) => l.includes("evidence 1/2"))).toHaveLength(2);
		expect(ev.some((l) => /evidence cleared: \d+ reported$/.test(l))).toBe(true);
		expect(h.lines.some((l) => l.includes("silent truncation:"))).toBe(false);
		expect(h.stats.plateaus).toHaveLength(0);
		expect(h.stats.lastLimits?.window).toBe(MODEL.contextWindow);
	});

	it("a small false-positive window (below 25% of the planning window) is re-probed and retired by honest usage", async () => {
		const h = await setup();
		// Calls 4 and 5 report no growth: call 4 is strong evidence and acts at once -> a window of about 10k (5%).
		scriptUsage(h.harness, (call, _honest, previous) => (call === 4 || call === 5 ? previous : undefined));
		for (let p = 0; p < 6; p++)
			await turns(
				h,
				Array.from({ length: 10 }, () => 6_000),
				400 + p * 20,
			);
		report("detector-confirmation", ENGINE_LABEL, "reprobe-false-positive", {
			evidence: evidence(h.lines),
			probes: h.stats.probes,
			learned: h.stats.learnedWindows,
		});
		expect(h.stats.plateaus).toHaveLength(1);
		expect(h.stats.plateaus[0].window).toBeLessThan(0.25 * MODEL.contextWindow);
		expect(h.lines.some((l) => l.includes("re-probe after 8 clean requests (0/2 used)"))).toBe(true);
		expect(h.lines.some((l) => l.includes("probe: silent-learned window") && l.includes("(re-probe 1/2"))).toBe(true);
		expect(h.lines.some((l) => l.includes("(learned window retired)"))).toBe(true);
		expect(h.stats.lastLimits?.window).toBe(MODEL.contextWindow);
	});

	it("a real silent truncator at 40k (20%): re-probed at most twice per session, truncated probe answers named", async () => {
		const h = await setup({ silentLimit: 40_000, silentReport: "limit" });
		for (let p = 0; p < 30 && h.stats.plateauReports.length < 4; p++)
			await turns(
				h,
				Array.from({ length: 10 }, () => 8_000),
				600 + p * 20,
			);
		const plateauProbes = h.lines.filter((l) => l.includes("probe: silent-learned window"));
		report("detector-confirmation", ENGINE_LABEL, "reprobe-real-truncator", {
			plateaus: h.stats.plateaus,
			probes: plateauProbes,
			reports: h.stats.plateauReports.map((r) => r.turns.map((t) => ({ turn: t.turn, probe: !!t.probe }))),
			detections: h.lines.filter((l) => l.includes("silent truncation:")),
		});
		// First detection, then two failed re-probes; the third detection is not re-probed.
		expect(h.stats.plateaus.length).toBe(3);
		for (const p of h.stats.plateaus) expect(p.window).toBeLessThanOrEqual(40_000);
		expect(plateauProbes).toHaveLength(2);
		const detections = h.lines.filter((l) => l.includes("silent truncation:"));
		expect(detections[0]).toContain("re-probe after 8 clean requests (0/2 used)");
		expect(detections[1]).toContain("the re-probe was truncated");
		expect(detections[1]).toContain("(1/2 used)");
		expect(detections[2]).toContain("the re-probe was truncated");
		expect(detections[2]).toContain("not re-probed");
		// G2 names the probe's truncated answers as probe answers.
		expect(h.stats.plateauReports[1].turns.some((t) => t.probe)).toBe(true);
		expect(h.stats.plateauReports[0].turns.some((t) => t.probe)).toBe(false);
		expect(h.lines.some((l) => l.includes("plateau: truncated probe answer"))).toBe(true);
		expect(h.stats.lastLimits?.window).toBeLessThanOrEqual(40_000);
	});

	it("a silent-learned window at or above 25% of the planning window is never re-probed", async () => {
		const h = await setup({ silentLimit: 60_000, silentReport: "limit" });
		for (let p = 0; p < 10; p++)
			await turns(
				h,
				Array.from({ length: 10 }, () => 8_000),
				900 + p * 20,
			);
		report("detector-confirmation", ENGINE_LABEL, "no-reprobe-30pct", {
			plateaus: h.stats.plateaus,
			probes: h.stats.probes,
		});
		expect(h.stats.plateaus).toHaveLength(1);
		expect(h.stats.plateaus[0].window).toBeGreaterThanOrEqual(0.25 * MODEL.contextWindow);
		expect(h.lines.find((l) => l.includes("silent truncation:"))).toContain("not re-probed");
		expect(h.stats.probes).toHaveLength(0);
	});
});
