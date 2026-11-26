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
 * than the one that set the maximum, by the requests' own estimates. And one honest repeat is weak evidence: it acts
 * with a second suspect, or with a growth marginal within the evidence span (ADR 0033).
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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

describe("0.9.0, ADR 0035: the different-request guard compares the requests' own estimates", () => {
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
