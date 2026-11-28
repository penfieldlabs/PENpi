/**
 * 0.9.0, ADR 0035: the exact-repeat rule within its allowance (silentEstimateError), at session level. A server that
 * fills its context reports exactly its limit, so a sample that reports exactly the largest usage reported so far
 * again is evidence when its request was expected above that, or below it within the allowance: E2's
 * data.o200k.32k.silent-front on the v1.5.1 corpus, call 12 (expected 0.963 of the maximum).
 *
 * The server holds 20,000 tokens and reports exactly that for a larger request. Each request that crosses the limit is
 * aimed at a target in the provider's tokens; the first crossing sets the largest usage reported, the second reports
 * it again expected above it (evidence by the rule as before), and the third is expected below it but counted above
 * it by the provider (a denser count, `extra`): exactly the maximum again, expected within the allowance below it.
 *
 * On honest providers: the same request sent again reports the same count, so the rule asks for a different request
 * than the one that set the maximum: a different shape (its messages, by identity), or an estimate more than 0.5% from
 * the maximum's. And one honest repeat is weak evidence: it acts with a second suspect, or with a growth marginal
 * within the evidence span (ADR 0033).
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	type ProviderSim,
	resendAnswered,
	scriptedModel,
	syntheticText,
	workExtension,
} from "./helpers.ts";

interface Plan {
	chars: number;
	/** Tokens added to what the provider counts for this call (a denser count). */
	extra?: number;
}

const LIMIT = 20_000;
const harnesses: Harness[] = [];

/** Faux-token targets of the crossings; `extra` pushes a crossing over the limit by the provider's count. */
async function crossings(targets: Array<{ at: number; extra?: number }>, engine: Record<string, unknown> = {}) {
	const stats = newStats();
	const rows: Array<{ call: number; line: string }> = [];
	let sim: ProviderSim | undefined;
	const plans: Plan[] = [];
	const harness = await createHarness({
		models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			createContextEngine({
				stats,
				...engine,
				log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	sim = installProviderSim(harness, {
		servedBy: (index) => {
			const extra = plans[index]?.extra ?? 0;
			return { holds: LIMIT, ...(extra !== 0 ? { offset: -extra } : {}) };
		},
	});
	const model = scriptedModel(harness);
	let next = 0;
	let phase: "regrow" | "big" = "regrow";
	for (let turn = 0; turn < 70; turn++)
		model.push(() => {
			const calls = sim!.calls;
			const last = calls.at(-1)?.promptTokens ?? 0;
			let plan: Plan;
			const target = targets[next];
			if (phase === "big") {
				// Over the limit by far, so the engine cuts and the next crossing starts from a regrow.
				phase = "regrow";
				plan = { chars: 32_000 };
			} else if (target && last >= 14_000) {
				next++;
				phase = "big";
				plan = { chars: Math.max(400, (target.at - last - 15) * 4), extra: target.extra };
			} else plan = { chars: !target && last >= 14_000 ? 160 : 4_000 };
			// The request after this answer carries its result.
			plans[calls.length] = plan;
			return fauxAssistantMessage(
				[fauxText(`Step ${turn}.`), fauxToolCall("work", { size: plan.chars, seed: turn }, { id: `call-${turn}` })],
				{ stopReason: "toolUse" },
			);
		});
	model.push(finalTurn("done"));
	await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
	const detectedAt = rows.find((r) => r.line.includes("silent truncation: ") && r.line.includes("window ->"))?.call;
	const at = plans.flatMap((p, i) => (p && p.chars !== 32_000 && p.chars !== 4_000 && p.chars !== 160 ? [i] : []));
	return {
		rows,
		detectedAt,
		at,
		reportedAt: at.map((i) => sim!.calls[i].processedTokens),
	};
}

describe("0.9.0, ADR 0035: the exact repeat within the allowance, at session level", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("the third crossing, expected about 2% below the maximum, completes the evidence: detection there; at 0, one later", async () => {
		// The fourth is above the maximum, and more than 0.5% from the first crossing's expected size.
		const targets = [{ at: 20_300 }, { at: 20_700 }, { at: 19_500, extra: 600 }, { at: 20_150 }];
		const on = await crossings(targets);
		expect(on.reportedAt.slice(0, 3)).toEqual([LIMIT, LIMIT, LIMIT]);
		expect(on.detectedAt).toBe(on.at[2]);
		// The log shows what the rule compared.
		const third = on.rows.find(
			(r) => r.call === on.at[2] && r.line.includes("reported exactly the previous maximum"),
		);
		expect(third?.line).toMatch(/expected about \d+ \(accepted from 19000 to 32000\)/);
		const off = await crossings(targets, { silentEstimateError: 0 });
		expect(off.detectedAt).toBe(off.at[3]);
	});

	it("its lower edge: a crossing expected 6% below the maximum is no evidence: detection waits for the next", async () => {
		const below = await crossings([{ at: 20_300 }, { at: 20_700 }, { at: 18_500, extra: 1_600 }, { at: 20_150 }]);
		expect(below.reportedAt[2]).toBe(LIMIT);
		expect(below.detectedAt).toBe(below.at[3]);
	});
});

describe("0.9.0, ADR 0035: the different-request guard compares the requests' own estimates, not their expected sizes", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("an honest resend of the request that set the maximum, after a 4% underestimate, is no evidence", async () => {
		const rows: Array<{ call: number; line: string }> = [];
		let sim: ProviderSim | undefined;
		const harness = await createHarness({
			models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					stats: newStats(),
					log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// 14 tool results, then the final answer's request (call 14), the largest, which the provider counts 4% denser
		// than the engine expects; its resend (call 15) is the same request and counts the same.
		const TOOLS = 14;
		sim = installProviderSim(harness, { servedBy: (index) => (index >= TOOLS ? { scale: 1.04 } : {}) });
		const model = scriptedModel(harness);
		for (let t = 0; t < TOOLS; t++)
			model.push(() =>
				fauxAssistantMessage(
					[fauxText(`Step ${t}.`), fauxToolCall("work", { size: 4_000, seed: t }, { id: `call-${t}` })],
					{ stopReason: "toolUse" },
				),
			);
		model.push(finalTurn("done"));
		await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
		model.push(finalTurn("done again"));
		await resendAnswered(harness, "done");

		expect(sim.calls).toHaveLength(TOOLS + 2);
		const [first, again] = sim.calls.slice(TOOLS);
		expect(again.processedTokens).toBe(first.processedTokens);
		expect(Math.max(...sim.calls.slice(0, TOOLS).map((c) => c.processedTokens))).toBeLessThan(first.processedTokens);
		expect(rows.some((r) => r.line.includes("silent truncation evidence"))).toBe(false);
		const line = rows.find((r) => r.call === TOOLS + 1 && r.line.includes("exact repeat not judged"))?.line;
		const [, estimate, maxEstimate, expected, maxExpected] = (
			line?.match(/estimate (\d+), the maximum's (\d+)\); expected about (\d+), the maximum's (\d+)/) ?? []
		).map(Number);
		expect(estimate).toBe(maxEstimate);
		// The gap the expected sizes alone let through: the ratio step after the first answer moved the resend's
		// expected size 0.5% or more, and it sits within the allowance below the maximum.
		expect(Math.abs(expected - maxExpected) / expected).toBeGreaterThanOrEqual(0.005);
		expect(expected).toBeLessThan(again.processedTokens);
		expect(expected).toBeGreaterThanOrEqual(0.95 * again.processedTokens);
	});
	// This pins the empty-answer rule of the guard's shape: an answer that sends nothing leaves the shape as it was. The
	// estimate-only guard took this resend for the same request too; a shape that kept the empty answer would not.
	it("the same request sent again by a real session's route, an empty answer and then an entry that isn't sent, is no evidence", async () => {
		const rows: Array<{ call: number; line: string }> = [];
		let sim: ProviderSim | undefined;
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				(pi: ExtensionAPI) => {
					api = pi;
				},
				createContextEngine({
					stats: newStats(),
					hiddenCustomTypes: ["unsent"],
					log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const TOOLS = 14;
		// Pi's converters skip the empty answer, but this simulator counts its characters: the resend is counted as the
		// request it repeats.
		sim = installProviderSim(harness, {
			servedBy: (index) => {
				if (index < TOOLS) return {};
				if (index === TOOLS + 1) {
					const first = sim!.calls[TOOLS];
					return { offset: sim!.calls[index].promptTokens - first.promptTokens, scale: 1.04 };
				}
				return { scale: 1.04 };
			},
		});
		const model = scriptedModel(harness);
		for (let t = 0; t < TOOLS; t++)
			model.push(() =>
				fauxAssistantMessage(
					[fauxText(`Step ${t}.`), fauxToolCall("work", { size: 4_000, seed: t }, { id: `call-${t}` })],
					{ stopReason: "toolUse" },
				),
			);
		// The answer to the largest request is empty: it sends nothing.
		model.push(finalTurn(""));
		await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
		model.push(finalTurn("done"));
		api!.sendMessage(
			{ customType: "unsent", content: "A reminder, not sent.", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();

		expect(sim.calls).toHaveLength(TOOLS + 2);
		const [first, again] = sim.calls.slice(TOOLS);
		expect(again.processedTokens).toBe(first.processedTokens);
		expect(rows.some((r) => r.line.includes("silent truncation evidence"))).toBe(false);
		expect(rows.some((r) => r.call === TOOLS + 1 && r.line.includes("exact repeat not judged"))).toBe(true);
	});
});

/**
 * An honest session that sets a maximum, cuts, regrows, and lands one request exactly on the maximum by chance (a
 * different request: larger content, counted lower). With `short`, a regrow request before it is counted short of
 * its append (0.35 of it: a growth marginal under ADR 0033), and the content it added stays counted that low.
 */
async function loneRepeat(short: boolean) {
	const rows: Array<{ call: number; line: string }> = [];
	let sim: ProviderSim | undefined;
	const harness = await createHarness({
		models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			createContextEngine({
				stats: newStats(),
				log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	let max: { call: number; reported: number } | undefined;
	let marginalAt: number | undefined;
	let repeatAt: number | undefined;
	let carry = 0;
	let cut = false;
	// What the provider reports: its own count, less what it counts low of the marginal's content, and exactly the
	// maximum for the request that lands within 300 tokens of it.
	const report = (index: number, prompt: number): number => {
		const calls = sim!.calls;
		if (index === marginalAt) {
			const before = calls[index - 1];
			const reported = before.processedTokens + Math.round(0.35 * (prompt - before.promptTokens));
			carry = prompt - reported;
			return reported;
		}
		if (index === repeatAt) return max!.reported;
		return prompt - carry;
	};
	sim = installProviderSim(harness, {
		servedBy: (index) => ({ offset: sim!.calls[index].promptTokens - report(index, sim!.calls[index].promptTokens) }),
	});
	const model = scriptedModel(harness);
	for (let turn = 0; turn < 60; turn++)
		model.push(() => {
			const calls = sim!.calls;
			const last = calls.at(-1)!;
			const index = calls.length;
			let size = 4_000;
			if (!max && last.promptTokens >= 19_000) {
				max = { call: index - 1, reported: last.processedTokens };
				size = 40_000;
			} else if (max && !cut) {
				cut = true;
			} else if (max && repeatAt === undefined) {
				const natural = last.promptTokens - carry;
				if (short && marginalAt === undefined && last.promptTokens >= 0.8 * max.reported) marginalAt = index;
				else if (natural >= max.reported - 2_000 && (!short || marginalAt !== undefined)) {
					// The next request lands near the maximum: about 16 tokens of framing per tool step.
					size = Math.max(400, (max.reported - natural - 16) * 4);
					repeatAt = index;
				}
			} else if (repeatAt !== undefined) size = 160;
			return fauxAssistantMessage(
				[fauxText(`Step ${turn}.`), fauxToolCall("work", { size, seed: turn }, { id: `call-${turn}` })],
				{ stopReason: "toolUse" },
			);
		});
	model.push(finalTurn("done"));
	await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
	const at = (call: number | undefined) => rows.filter((r) => r.call === call).map((r) => r.line);
	return { sim, rows, max: max!, marginalAt, repeatAt, at };
}

describe("0.9.0, ADR 0035: one honest repeat is weak evidence (ADR 0033)", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("alone, it stays one suspect; with a growth marginal earlier in the evidence span, the two detect", async () => {
		const alone = await loneRepeat(false);
		expect(alone.repeatAt).toBeDefined();
		expect(alone.sim.calls[alone.repeatAt!].processedTokens).toBe(alone.max.reported);
		expect(
			alone.at(alone.repeatAt).some((l) => l.includes("evidence 1/2: reported exactly the previous maximum")),
		).toBe(true);
		expect(alone.rows.some((r) => r.line.includes("window ->"))).toBe(false);

		const paired = await loneRepeat(true);
		expect(paired.marginalAt).toBeDefined();
		expect(paired.at(paired.marginalAt).some((l) => l.includes("kept for a pair with evidence"))).toBe(true);
		expect(paired.sim.calls[paired.repeatAt!].processedTokens).toBe(paired.max.reported);
		const lines = paired.at(paired.repeatAt);
		expect(lines.some((l) => l.includes("marginal sample(s) earlier in the span join this evidence"))).toBe(true);
		expect(lines.some((l) => l.includes("reported exactly the previous maximum") && l.includes("window ->"))).toBe(
			true,
		);
	});
});

/**
 * A server that silently truncates at exactly the count of the request that set the maximum (`holds`). The session
 * grows to that request, then a large tool result makes the engine cut; the first request after the cut counts a
 * little denser than the engine expects (`extra`), so it is truncated and reports exactly the maximum again. `early`
 * is the size of the first step, which the cut drops: it moves the maximum-setter's estimate and not the post-cut
 * request's, so the two can be brought within 0.5% of each other.
 */
async function postCut(early: number, GROW_TO = 9_000, lowWater?: number) {
	const stats = newStats();
	const rows: Array<{ call: number; line: string }> = [];
	let sim: ProviderSim | undefined;
	const harness = await createHarness({
		models: [{ id: "srv", contextWindow: 22_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			createContextEngine({
				stats,
				...(lowWater !== undefined ? { lowWater } : {}),
				log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	let maxAt: number | undefined;
	sim = installProviderSim(harness, {
		servedBy: (index) => {
			if (maxAt === undefined || index <= maxAt) return {};
			return { holds: sim!.calls[maxAt].processedTokens, ...(index === maxAt + 1 ? { offset: -300 } : {}) };
		},
	});
	const model = scriptedModel(harness);
	for (let turn = 0; turn < 40; turn++)
		model.push(() => {
			const calls = sim!.calls;
			let size = turn === 0 ? early : 4_000;
			if (maxAt === undefined && (calls.at(-1)?.promptTokens ?? 0) >= GROW_TO) {
				maxAt = calls.length - 1;
				size = 56_000;
			} else if (maxAt !== undefined) size = 160;
			return fauxAssistantMessage(
				[fauxText(`Step ${turn}.`), fauxToolCall("work", { size, seed: turn }, { id: `call-${turn}` })],
				{ stopReason: "toolUse" },
			);
		});
	model.push(finalTurn("done"));
	await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
	const after = maxAt! + 1;
	return {
		rows,
		sim,
		maxAt: maxAt!,
		after,
		estimates: [stats.sent[maxAt!].estimate, stats.sent[after].estimate],
		at: (call: number) => rows.filter((r) => r.call === call).map((r) => r.line),
	};
}

/**
 * The post-cut session with the first step sized so the two estimates land within `within` of each other. The size is
 * searched at run time: the estimates move with the system prompt, which carries the checkout's paths, so no fixed
 * size holds from every checkout. The first step is dropped by the cut, so it moves only the maximum-setter's
 * estimate. A scan in steps of 250 characters finds where the gap changes sign with the same request setting the
 * maximum (a larger step can make an earlier request the maximum-setter); steps of 25 inside that interval find a fit.
 */
async function postCutWithin(within: number) {
	type Run = Awaited<ReturnType<typeof postCut>>;
	const gap = (r: Run) => (r.estimates[0] - r.estimates[1]) / r.estimates[0];
	const run = async (early: number) => {
		const r = await postCut(early, 9_000, 0.55);
		while (harnesses.length > 1) harnesses.shift()?.cleanup();
		return r;
	};
	let previous: { early: number; r: Run } | undefined;
	for (let early = 5_000; early <= 12_000; early += 250) {
		const r = await run(early);
		if (Math.abs(gap(r)) < within) return r;
		if (previous && previous.r.maxAt === r.maxAt && gap(previous.r) < 0 && gap(r) > 0)
			for (let fine = previous.early + 25; fine < early; fine += 25) {
				const f = await run(fine);
				if (Math.abs(gap(f)) < within) return f;
			}
		previous = { early, r };
	}
	throw new Error(`no first-step size puts the two estimates within ${within * 100}%`);
}

describe("0.9.0, ADR 0035: the guard tells requests apart by their shape", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a truncated request after a cut, its estimate within 0.5% of the maximum's, reporting exactly the maximum, is evidence", async () => {
		const r = await postCutWithin(0.005);
		const [maxEstimate, estimate] = r.estimates;
		// What the estimate alone took for the same request: within 0.5% of the maximum-setter's.
		expect(Math.abs(estimate - maxEstimate) / maxEstimate).toBeLessThan(0.005);
		// A different request: the engine cut in it, so it is not the maximum-setter's shape.
		expect(r.at(r.after - 1).some((l) => l.includes("cut #1"))).toBe(true);
		// Truncated: the provider counted more than it holds, and reported exactly the maximum.
		const call = r.sim.calls[r.after];
		expect(call.promptTokens + 300).toBeGreaterThan(r.sim.calls[r.maxAt].processedTokens);
		expect(call.processedTokens).toBe(r.sim.calls[r.maxAt].processedTokens);
		const lines = r.at(r.after);
		expect(lines.some((l) => l.includes("evidence 1/2: reported exactly the previous maximum"))).toBe(true);
		expect(lines.some((l) => l.includes("exact repeat not judged"))).toBe(false);
	});
});

describe("0.9.0, ADR 0035: the engine's own messages are keyed by their text", () => {
	const realNow = Date.now;
	afterEach(() => {
		Date.now = realNow;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	it("an identical request whose window header was rebuilt with another timestamp is the same request", async () => {
		// Every read of the clock is 5 ms later than the last, so a message built at one moment and one rebuilt from a
		// session entry never share a timestamp by chance.
		let clock = realNow();
		Date.now = () => {
			clock += 5;
			return clock;
		};
		const rows: Array<{ call: number; line: string }> = [];
		let sim: ProviderSim | undefined;
		const harness = await createHarness({
			models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					stats: newStats(),
					log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		sim = installProviderSim(harness, {});
		const model = scriptedModel(harness);
		// Large steps until the engine has cut, then small ones, so the regrowth sets a new maximum after that cut (the
		// request answered "Step <maxStep>."); then large steps again, so the engine cuts once more after it.
		let peak = 0;
		let cuts = 0;
		let maxStep: number | undefined;
		let maxCall: number | undefined;
		for (let t = 0; t < 120; t++)
			model.push(() => {
				const calls = sim!.calls;
				const seen = rows.filter((r) => r.line.includes("cut #")).length;
				if (cuts === 0 && seen > 0) peak = Math.max(...calls.slice(0, -1).map((c) => c.processedTokens));
				cuts = seen;
				const last = calls.at(-1)?.processedTokens ?? 0;
				let size = 4_000;
				if (cuts >= 1 && maxStep === undefined) {
					if (last > peak + 300) {
						maxStep = t;
						maxCall = calls.length - 1;
					} else size = 600;
				}
				if (maxStep !== undefined && cuts >= 2 && t > maxStep + 2) return fauxAssistantMessage("done");
				return fauxAssistantMessage(
					[fauxText(`Step ${t}.`), fauxToolCall("work", { size, seed: t }, { id: `call-${t}` })],
					{ stopReason: "toolUse" },
				);
			});
		await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
		const before = sim.calls.length;
		model.push(finalTurn("resent"));
		await resendAnswered(harness, `Step ${maxStep}.`);
		Date.now = realNow;
		// The request that set the maximum came after the first cut, and the engine cut again after it; the resend from
		// the same point rebuilds the window as of the first cut, with its header made again at another time.
		expect(rows.filter((r) => r.line.includes("cut #")).length).toBeGreaterThanOrEqual(2);
		const again = sim.calls.at(-1)!;
		expect(again.processedTokens).toBe(sim.calls[maxCall!].processedTokens);
		expect(Math.max(...sim.calls.slice(0, -1).map((c) => c.processedTokens))).toBe(again.processedTokens);
		expect(rows.some((r) => r.call >= before && r.line.includes("silent truncation evidence"))).toBe(false);
		const line = rows.find((r) => r.call >= before && r.line.includes("exact repeat not judged"))?.line;
		const [, shape, maxShape, estimate, maxEstimate] =
			line?.match(/shape (\w+), the maximum's (\w+); estimate (\d+), the maximum's (\d+)/) ?? [];
		expect(shape).toBeDefined();
		expect(shape).toBe(maxShape);
		expect(estimate).toBe(maxEstimate);
	});
});
