/**
 * 0.8.0, ADR 0033: a marginal sample (growth below silentMarginal 0.5, above silentShortfall 0.25) and an evidence
 * sample within the evidence span count as two suspects, in either order. E2's research.glm.32k.silent-messages on
 * the v1.5.0 corpus: call 11 marginal, call 18 evidence, detection at call 19 (lag 2, was 4). Two marginal samples
 * never detect on their own: honest content can read marginal, twice in a row (a repeated `git diff --stat`). A clean
 * sample above everything reported so far forgets marginal samples, as it clears evidence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { installProviderSim, type ProviderSim, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

/** Tokens the server leaves out of its report, per call from `from` on: growth short by that much on that call. */
async function run(from: number, drops: number[], options: Record<string, unknown> = {}) {
	const stats = newStats();
	const lines: string[] = [];
	let sim: ProviderSim | undefined;
	let detectedAtCall: number | undefined;
	const harness = await createHarness({
		models: [{ id: "srv-200k", contextWindow: 200_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			createContextEngine({
				stats,
				...options,
				log: (line) => {
					lines.push(line);
					if (detectedAtCall === undefined && line.includes("silent truncation: ") && line.includes("window ->"))
						detectedAtCall = sim?.calls.length;
				},
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const offset = (index: number) => drops.slice(0, Math.max(0, index - from + 1)).reduce((sum, d) => sum + d, 0);
	sim = installProviderSim(harness, {
		servedBy: (index) => ({ offset: index < from ? undefined : offset(index) }),
	});
	const model = scriptedModel(harness);
	// Every result 4,000 characters (about 1,000 tokens): honest growth ratios stay close to 1.
	await runPrompts(harness, model, { prompts: 1, turns: from + drops.length + 4, min: 4_000, spread: 0 });
	// The growth ratio of each judged sample from `from` on, in call order.
	const ratios = stats.growthChecks.filter((g) => g.grow >= 256).map((g) => g.delta / g.grow);
	return { stats, lines, detectedAtCall, ratios };
}

const harnesses: Harness[] = [];
/** About 55% of a 1,000-token append left out: marginal. */
const MARGINAL = 560;
/** About 80% left out: evidence, but not strong (that needs less than 0.15 of an append of 1,000 or more). */
const EVIDENCE = 800;
const FROM = 12;
const evidenceLines = (lines: string[]) =>
	lines.filter((l) => l.includes("silent truncation evidence ") && !l.includes("evidence cleared"));
const marginalLines = (lines: string[]) => lines.filter((l) => l.includes("silent truncation marginal sample:"));

describe("ADR 0033: a marginal sample and an evidence sample within the span detect together", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a marginal sample, then evidence: detection after the evidence", async () => {
		const r = await run(FROM, [MARGINAL, EVIDENCE]);
		const short = r.ratios.filter((x) => x < 0.5);
		expect(short).toHaveLength(2);
		expect(short[0]).toBeGreaterThan(0.25);
		expect(short[1]).toBeLessThan(0.25);
		expect(short[1]).toBeGreaterThan(0.15);
		expect(marginalLines(r.lines)).toHaveLength(1);
		expect(r.lines.some((l) => l.includes("1 marginal sample(s) earlier in the span join this evidence"))).toBe(true);
		expect(r.stats.plateaus).toHaveLength(1);
		// The evidence answers call FROM + 1; the next call is the first sent with the learned window.
		expect(r.detectedAtCall).toBe(FROM + 2);
	});

	it("evidence, then a marginal sample: detection after the marginal one, which is quarantined", async () => {
		const r = await run(FROM, [EVIDENCE, MARGINAL]);
		const short = r.ratios.filter((x) => x < 0.5);
		expect(short).toHaveLength(2);
		expect(short[0]).toBeLessThan(0.25);
		expect(short[1]).toBeGreaterThan(0.25);
		expect(evidenceLines(r.lines)).toHaveLength(2);
		expect(r.lines.some((l) => l.includes("a marginal sample with evidence earlier in the span"))).toBe(true);
		expect(r.stats.plateaus).toHaveLength(1);
		expect(r.detectedAtCall).toBe(FROM + 2);
	});

	it("two marginal samples alone do not detect", async () => {
		const r = await run(FROM, [MARGINAL, MARGINAL]);
		const short = r.ratios.filter((x) => x < 0.5);
		expect(short).toHaveLength(2);
		for (const x of short) expect(x).toBeGreaterThan(0.25);
		expect(marginalLines(r.lines)).toHaveLength(2);
		expect(evidenceLines(r.lines)).toHaveLength(0);
		expect(r.stats.plateaus).toHaveLength(0);
	});

	it("a clean sample above everything reported in between forgets the marginal sample: evidence then waits for a second", async () => {
		const r = await run(FROM, [MARGINAL, 0, EVIDENCE]);
		expect(r.ratios.filter((x) => x < 0.5)).toHaveLength(2);
		expect(r.lines.some((l) => l.includes("silent truncation marginal samples cleared"))).toBe(true);
		expect(evidenceLines(r.lines)).toHaveLength(1);
		expect(r.stats.plateaus).toHaveLength(0);
	});

	it("control: with the rule off (the internal option), a marginal sample and evidence do not detect", async () => {
		const r = await run(FROM, [MARGINAL, EVIDENCE], { silentMarginalPair: false });
		expect(r.ratios.filter((x) => x < 0.5)).toHaveLength(2);
		expect(evidenceLines(r.lines)).toHaveLength(1);
		expect(r.stats.plateaus).toHaveLength(0);
	});
});
