/**
 * D24 (RC2 trial): OpenRouter moved GLM 5.3 Flash from one upstream provider to another mid-session. The two count
 * the same request differently (native prompt tokens 97,709 -> 97,173 after 175 tokens were appended), so the
 * silent-truncation detector read a strong sample and learned a window of 137,764 (this session only), with extra
 * cuts from then on. Nothing was dropped.
 *
 * The router names the serving provider in its stream (OpenRouter's top-level `provider` field), which Pi forwards
 * to extensions as provider_stream_event. A sample served by a different provider than the previous one is judged
 * against that provider's own last sample in the same append chain (S1), and not judged when there is none. Each
 * provider keeps its own evidence and running maximum (N1, N2). A real truncation after a switch is still detected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

async function session(options: Parameters<typeof installProviderSim>[1]) {
	const stats = newStats();
	const lines: string[] = [];
	// The same session directory (cwd is in the system prompt) and entry ids for every session, so two sessions
	// with the same script send the same requests (case a compares them).
	resetEntryIds();
	const clock = vi.spyOn(Date, "now").mockReturnValue(1_792_000_000_000);
	const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
	const created = createHarness({
		models: [{ id: "router-128k", contextWindow: 128_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [workExtension, createContextEngine({ stats, log: (line) => lines.push(line) })],
	});
	clock.mockRestore();
	random.mockRestore();
	const harness = await created;
	await harness.session.bindExtensions({});
	const sim = installProviderSim(harness, options);
	const model = scriptedModel(harness, 400);
	return { harness, stats, lines, sim, model };
}

/** About 19,000 tokens in 25 results of 3,000 characters, then small appends of about 150 tokens. */
async function run(t: Awaited<ReturnType<typeof session>>, small: number) {
	for (let i = 0; i < 25; i++) t.model.push(toolTurn(3_000, i));
	t.model.push(finalTurn("filled"));
	await t.harness.session.prompt("task 1: read the batch.");
	for (let i = 0; i < small; i++) t.model.push(toolTurn(600, 100 + i));
	t.model.push(finalTurn("done"));
	await t.harness.session.prompt("task 2: read the rest, one small file at a time.");
}

describe("D24: an upstream provider switch behind a router is not silent truncation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("honest providers that count 2% apart: no evidence, no learned window, the switch logged", async () => {
		// Provider A until call 35, B (2% fewer tokens for the same request) until call 45, then A again.
		const t = await session({
			servedBy: (i) => (i >= 35 && i < 45 ? { name: "Crusoe", scale: 0.98 } : { name: "OpenInference", scale: 1 }),
		});
		harnesses.push(t.harness);
		await run(t, 30);
		expect(t.sim.calls.length).toBeGreaterThan(50);
		expect(t.sim.calls.some((c) => c.truncatedInput)).toBe(false);
		const evidence = t.lines.filter((l) => l.includes("silent truncation evidence"));
		expect(evidence, "silent truncation evidence").toEqual([]);
		expect(t.stats.plateaus, "learned windows").toEqual([]);
		expect(t.stats.learnedWindows).toEqual([]);
		const switches = t.lines.filter((l) => l.includes("serving provider changed"));
		expect(switches).toHaveLength(2);
		expect(switches[0]).toContain("OpenInference -> Crusoe");
	});

	it("(a) the same provider named on every response: the detector behaves exactly as with none named", async () => {
		// A server holding 24,000 tokens, as silent-detector's 64k case: evidence and a learned window either way.
		const outcome = async (named: boolean) => {
			const t = await session({
				silentLimit: 24_000,
				...(named ? { servedBy: () => ({ name: "OpenInference" }) } : {}),
			});
			harnesses.push(t.harness);
			await run(t, 60);
			return {
				detector: t.lines
					.filter((l) => /silent truncation|plateau|learned|serving provider/.test(l))
					.map((l) => l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>")),
				samples: t.stats.calibrationSamples,
				plateaus: t.stats.plateaus,
				processed: t.sim.calls.map((c) => c.processedTokens),
			};
		};
		const plain = await outcome(false);
		const named = await outcome(true);
		expect(plain.plateaus.length, "the scenario detects truncation").toBeGreaterThan(0);
		expect(plain.detector.some((l) => l.includes("silent truncation evidence"))).toBe(true);
		expect(named).toEqual(plain);
		expect(named.detector.filter((l) => l.includes("serving provider"))).toEqual([]);
	});

	it("(b) a truncation that starts exactly at the switch is detected one sample later: the switch sample is exempt", async () => {
		// From call 35 Crusoe serves and keeps only 15,000 tokens (about 5,000 below the request), reporting that.
		const SWITCH = 35;
		const plateausBefore: number[] = [];
		let t!: Awaited<ReturnType<typeof session>>;
		t = await session({
			servedBy: (i) => {
				plateausBefore[i] = t.stats.plateaus.length;
				return i >= SWITCH ? { name: "Crusoe", holds: 15_000 } : { name: "OpenInference" };
			},
		});
		harnesses.push(t.harness);
		await run(t, 30);
		expect(t.sim.calls[SWITCH].truncatedInput, "the switch request is truncated").toBe(true);
		expect(t.sim.calls[SWITCH - 1].truncatedInput).toBe(false);
		// The switch sample (call 35) is not judged; the next one (call 36, nothing appended counted) is strong.
		expect(plateausBefore[SWITCH + 1], "not detected at the switch sample").toBe(0);
		expect(plateausBefore[SWITCH + 2], "detected at the sample after it").toBe(1);
		const switched = t.lines.findIndex((l) => l.includes("serving provider changed (OpenInference -> Crusoe)"));
		const evidence = t.lines.findIndex((l) => l.includes("silent truncation evidence"));
		expect(switched).toBeGreaterThanOrEqual(0);
		expect(evidence).toBeGreaterThan(switched);
	});

	it("(c) a failed response that named another provider leaves nothing behind: the next good samples are judged as usual", async () => {
		// Call 40 fails after its stream named Crusoe. Every good response is OpenInference's, except the one right
		// after the failure, which names none: a provider left over from the failed response would be read as its.
		const FAILED = 40;
		const t = await session({
			servedBy: (i) => (i === FAILED ? { name: "Crusoe" } : i === FAILED + 1 ? {} : { name: "OpenInference" }),
			reject: ({ index }) => (index === FAILED ? "400 invalid request (test)" : undefined),
		});
		harnesses.push(t.harness);
		await run(t, 30).catch(() => {});
		for (let i = 0; i < 10; i++) t.model.push(toolTurn(600, 200 + i));
		t.model.push(finalTurn("after"));
		await t.harness.session.prompt("task 3: carry on.");
		expect(t.sim.calls[FAILED].rejected, "the failed request").toBe(true);
		expect(t.sim.calls.length).toBeGreaterThan(FAILED + 10);
		expect(
			t.lines.filter((l) => l.includes("serving provider changed")),
			"no switch seen",
		).toEqual([]);
		expect(t.lines.filter((l) => l.includes("silent truncation evidence"))).toEqual([]);
	});

	it("the trial's case: one switch between honest providers 0.5-3% apart leaves no evidence", async () => {
		for (const scale of [0.995, 0.97, 1.03]) {
			const t = await session({
				servedBy: (i) => (i >= 35 ? { name: "Crusoe", scale } : { name: "OpenInference", scale: 1 }),
			});
			harnesses.push(t.harness);
			await run(t, 30);
			expect(
				t.lines.filter((l) => l.includes("silent truncation evidence")),
				`scale ${scale}`,
			).toEqual([]);
			expect(t.stats.plateaus, `scale ${scale}`).toEqual([]);
			expect(t.lines.filter((l) => l.includes("serving provider changed"))).toHaveLength(1);
		}
	});

	it("S1: providers alternating on every call, one of them dropping the oldest messages: detected, its answers named", async () => {
		// A is honest; B silently drops the oldest messages above 24,000 tokens and reports what it kept.
		const t = await session({
			servedBy: (i) => (i % 2 === 1 ? { name: "B", drops: 24_000 } : { name: "A" }),
		});
		harnesses.push(t.harness);
		await run(t, 60);
		const truncated = t.sim.calls.filter((c) => c.truncatedInput);
		expect(truncated.length, "B truncated").toBeGreaterThan(0);
		expect(t.stats.plateaus.length, "detected").toBeGreaterThan(0);
		// Every switch sample has a same-provider reference (alternation, no cut in between): judged, not exempt.
		expect(t.lines.some((l) => /serving provider changed \(A -> B\): judged against B's sample/.test(l))).toBe(true);
		// The named answers are B's truncated ones: each reported what a truncated request of B processed.
		const named = t.lines.filter((l) => l.includes("plateau: truncated answer"));
		expect(named.length, "answers named").toBeGreaterThan(0);
		const processedByB = new Set(truncated.map((c) => c.processedTokens));
		for (const line of named) expect(processedByB.has(Number(/processed=(\d+)/.exec(line)?.[1])), line).toBe(true);
	});

	it("N1: evidence does not carry across a switch that comes right after a length stop", async () => {
		// A weak shortfall on A (call 32, whose answer stops at the length limit), the continuation on B (33, not
		// judged after a length stop), then a weak shortfall on B (34): one piece of evidence per provider.
		const t = await session({
			servedBy: (i) =>
				i < 33
					? { name: "A", ...(i === 32 ? { offset: 550 } : {}) }
					: { name: "B", ...(i === 34 ? { offset: 550 } : {}) },
		});
		harnesses.push(t.harness);
		for (let i = 0; i < 25; i++) t.model.push(toolTurn(3_000, i));
		t.model.push(finalTurn("filled"));
		await t.harness.session.prompt("task 1: read the batch.");
		for (let i = 0; i < 5; i++) t.model.push(toolTurn(600, 100 + i));
		t.model.push(toolTurn(2_400, 110));
		t.model.push(finalTurn("a long answer that stops at the limit", "length"));
		t.model.push(toolTurn(2_400, 111));
		t.model.push(finalTurn("done"));
		await t.harness.session.prompt("task 2: read the rest.");
		expect(t.stats.plateaus, "no detection from mixed evidence").toEqual([]);
		const evidence = t.lines.filter((l) => l.includes("silent truncation evidence"));
		expect(evidence, "one weak shortfall on each provider").toHaveLength(2);
		expect(evidence.every((l) => l.includes("evidence 1/2") && !l.includes("(strong)"))).toBe(true);
		expect(t.lines.some((l) => l.includes("serving provider changed (A -> B)"))).toBe(true);
	});

	it("N2: a learned window comes from the provider that truncated, not a previous provider's higher count", async () => {
		// A counts 3% more than B. B serves from call 45: honestly for two calls (below A's last count, since 3% of
		// about 21,000 tokens is more than two small appends), then it reports at most 19,000.
		const t = await session({
			servedBy: (i) =>
				i < 45
					? { name: "A", scale: 1.03 }
					: i < 47
						? { name: "B", scale: 1 }
						: { name: "B", scale: 1, holds: 19_000 },
		});
		harnesses.push(t.harness);
		await run(t, 30);
		expect(t.stats.plateaus.length, "detected").toBeGreaterThan(0);
		const maxA = Math.max(...t.sim.calls.slice(0, 45).map((c) => c.processedTokens));
		const maxB = Math.max(...t.sim.calls.slice(45, 47).map((c) => c.processedTokens));
		expect(maxA, "A's count is the higher").toBeGreaterThan(maxB);
		expect(t.stats.plateaus[0].window, "learned from B's own maximum").toBe(maxB);
	});

	it("R1: a switch sample is not judged across a length stop (the cut answer is counted provider-specifically)", async () => {
		// A and B alternate. A's answer at call 30 stops at the length limit; the continuation (31) is on B; call 32 is
		// A again. Its reference, A's call 30, lies before the cut answer, which the provider counts at a share of its
		// text. At half the shortfall is only marginal; at a tenth it would be evidence. Neither may be.
		for (const share of [0.5, 0.1]) {
			const t = await session({
				cutAnswerShare: share,
				servedBy: (i) => (i % 2 === 0 ? { name: "A" } : { name: "B" }),
			});
			harnesses.push(t.harness);
			for (let i = 0; i < 25; i++) t.model.push(toolTurn(3_000, i));
			t.model.push(finalTurn("filled"));
			await t.harness.session.prompt("task 1: read the batch.");
			for (let i = 0; i < 4; i++) t.model.push(toolTurn(600, 100 + i));
			t.model.push(finalTurn(`A long answer. ${"It goes on and on about the batch. ".repeat(240)}`, "length"));
			for (let i = 0; i < 6; i++) t.model.push(toolTurn(600, 120 + i));
			t.model.push(finalTurn("done"));
			await t.harness.session.prompt("task 2: read the rest, then sum it up.");
			expect(
				t.lines.some((l) => l.includes("length stop: the next usage sample is not judged")),
				`share ${share}`,
			).toBe(true);
			expect(
				t.lines.filter((l) => l.includes("silent truncation evidence")),
				`share ${share}: evidence`,
			).toEqual([]);
			expect(t.stats.plateaus, `share ${share}`).toEqual([]);
		}
	});

	it("a provider that truncates after a switch is still detected", async () => {
		// B serves from call 20 and silently drops the oldest messages above 24,000 tokens.
		const t = await session({
			silentLimit: 24_000,
			silentReport: "remainder",
			servedBy: (i) => (i >= 20 ? { name: "Crusoe", scale: 1 } : { name: "OpenInference", scale: 1 }),
		});
		harnesses.push(t.harness);
		await run(t, 60);
		const firstTruncated = t.sim.calls.findIndex((c) => c.truncatedInput);
		expect(firstTruncated).toBeGreaterThan(20);
		expect(t.stats.plateaus.length, "detected").toBeGreaterThan(0);
	});
});
